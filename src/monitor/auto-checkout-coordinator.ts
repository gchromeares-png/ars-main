import type { Task, TaskConfig } from "../models";
import type { TaskOrchestrator } from "../orchestrator";
import type { CheckoutPaymentSession } from "../payments/models";
import type { ProxySelection } from "../proxies/models";
import type { ProductMonitorEvent } from "./models";

export interface AutoCheckoutActionConfig {
  mode: "auto-checkout";
  profileId: string;
  proxySelection?: ProxySelection;
  headless?: boolean;
  paymentEnabled?: boolean;
}

export interface MonitorOnlyActionConfig {
  mode: "monitor-only";
}

export type MonitorActionConfig = AutoCheckoutActionConfig | MonitorOnlyActionConfig;

export interface AutoCheckoutRuntimeStatus {
  status: "triggering" | "triggered" | "failed";
  childTaskId?: string;
  triggeredAt: string;
  eventType: ProductMonitorEvent["type"];
  productKey: string;
  productTitle: string;
  productUrl?: string;
  error?: string;
}

export interface AutoCheckoutCoordinatorOptions {
  getPaymentSession?: (taskId: string) => CheckoutPaymentSession | undefined;
  setPaymentSession?: (taskId: string, session: CheckoutPaymentSession) => void;
  onTriggered?: (parent: Task, child: Task, event: ProductMonitorEvent) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function getMonitorAction(task: Task): MonitorActionConfig {
  const raw = asRecord(task.config.data?.["monitorAction"]);
  if (raw?.["mode"] !== "auto-checkout") return { mode: "monitor-only" };

  const profileId = String(raw["profileId"] ?? "").trim();
  const proxySelection = asRecord(raw["proxySelection"]) as ProxySelection | undefined;
  return {
    mode: "auto-checkout",
    profileId,
    proxySelection,
    headless: Boolean(raw["headless"]),
    paymentEnabled: Boolean(raw["paymentEnabled"])
  };
}

export class MonitorAutoCheckoutCoordinator {
  private readonly triggeredParents = new Set<string>();

  constructor(
    private readonly orchestrator: TaskOrchestrator,
    private readonly options: AutoCheckoutCoordinatorOptions = {}
  ) {}

  async handleProductEvent(parentTaskId: string, event: ProductMonitorEvent): Promise<Task | undefined> {
    const parent = this.orchestrator.getTask(parentTaskId);
    if (!parent) return undefined;

    const action = getMonitorAction(parent);
    if (action.mode !== "auto-checkout") return undefined;
    if (!event.current.available) return undefined;
    if (!action.profileId) {
      this.markFailed(parent, event, "Auto-Checkout-Profil fehlt.");
      return undefined;
    }

    const existingRuntime = asRecord(parent.config.data?.["autoCheckoutRuntime"]);
    if (existingRuntime?.["childTaskId"] || this.triggeredParents.has(parent.id)) return undefined;

    this.triggeredParents.add(parent.id);
    const triggeredAt = new Date().toISOString();
    const childTaskId = `${parent.id}__checkout_${Date.now()}`;

    parent.config.data = {
      ...(parent.config.data ?? {}),
      autoCheckoutRuntime: this.runtimeStatus("triggering", event, triggeredAt, childTaskId)
    };

    try {
      const childConfig: TaskConfig = {
        id: childTaskId,
        name: `${parent.config.name} · Checkout`,
        shopId: parent.config.shopId,
        maxRetries: parent.config.maxRetries,
        data: {
          searchTerm: event.current.url || event.current.title,
          browserConfig: { headless: action.headless ?? false },
          profileId: action.profileId,
          proxySelection: action.proxySelection ?? { mode: "profile-default" },
          triggerSource: {
            parentTaskId: parent.id,
            eventType: event.type,
            productKey: event.key,
            productTitle: event.current.title,
            productUrl: event.current.url,
            observedAt: event.observedAt.toISOString(),
            price: event.current.price ? { ...event.current.price } : undefined,
            stock: event.current.stock
          }
        }
      };

      const child = this.orchestrator.createTask(childConfig);

      const paymentSession = action.paymentEnabled
        ? this.options.getPaymentSession?.(parent.id)
        : undefined;
      if (paymentSession) {
        this.options.setPaymentSession?.(child.id, {
          ...paymentSession,
          card: paymentSession.card ? { ...paymentSession.card } : undefined
        });
      }

      parent.config.data = {
        ...(parent.config.data ?? {}),
        autoCheckoutRuntime: this.runtimeStatus("triggered", event, triggeredAt, child.id)
      };

      // Stop the one-shot monitor first. This frees its orchestrator slot; the child
      // starts immediately or is queued until that slot is released.
      this.orchestrator.cancelTask(parent.id);
      void this.orchestrator.startTask(child.id);
      this.options.onTriggered?.(parent, child, event);
      return child;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markFailed(parent, event, message, triggeredAt);
      this.triggeredParents.delete(parent.id);
      return undefined;
    }
  }

  private markFailed(parent: Task, event: ProductMonitorEvent, error: string, triggeredAt = new Date().toISOString()): void {
    parent.config.data = {
      ...(parent.config.data ?? {}),
      autoCheckoutRuntime: {
        ...this.runtimeStatus("failed", event, triggeredAt),
        error
      }
    };
    parent.lastError = error;
  }

  private runtimeStatus(
    status: AutoCheckoutRuntimeStatus["status"],
    event: ProductMonitorEvent,
    triggeredAt: string,
    childTaskId?: string
  ): AutoCheckoutRuntimeStatus {
    return {
      status,
      childTaskId,
      triggeredAt,
      eventType: event.type,
      productKey: event.key,
      productTitle: event.current.title,
      productUrl: event.current.url
    };
  }
}
