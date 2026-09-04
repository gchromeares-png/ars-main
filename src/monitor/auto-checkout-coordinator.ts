import type { Task, TaskConfig } from "../models";
import type { TaskOrchestrator } from "../orchestrator";
import type { CheckoutPaymentSession } from "../payments/models";
import type { ProxySelection } from "../proxies/models";
import { getMonitorStrategy, setEarlyGateRuntime, type PreCheckoutGateEvent } from "./early-gate";
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
  onGateTriggered?: (parent: Task, child: Task, event: PreCheckoutGateEvent) => void;
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
            kind: "product",
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
      this.copyPaymentSession(parent, child, action);

      parent.config.data = {
        ...(parent.config.data ?? {}),
        autoCheckoutRuntime: this.runtimeStatus("triggered", event, triggeredAt, child.id)
      };

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

  async handleGateEvent(parentTaskId: string, event: PreCheckoutGateEvent): Promise<Task | undefined> {
    const parent = this.orchestrator.getTask(parentTaskId);
    if (!parent || this.triggeredParents.has(parent.id)) return undefined;
    const strategy = getMonitorStrategy(parent);
    if (strategy.mode !== "early-gate") return undefined;

    const action = getMonitorAction(parent);
    if (action.mode !== "auto-checkout" || !action.profileId) {
      parent.lastError = "Early-Gate benötigt eine Auto-Checkout-Session mit Profil.";
      return undefined;
    }

    const runtime = asRecord(parent.config.data?.["earlyGateRuntime"]);
    if (runtime?.["childTaskId"]) return undefined;

    this.triggeredParents.add(parent.id);
    const childTaskId = `${parent.id}__gate_${Date.now()}`;
    const observedAt = event.observedAt.toISOString();
    const flowId = `early-gate:${parent.id}`;

    try {
      const childConfig: TaskConfig = {
        id: childTaskId,
        name: `${parent.config.name} · Release`,
        shopId: parent.config.shopId,
        maxRetries: parent.config.maxRetries,
        data: {
          browserConfig: {
            headless: action.headless ?? false,
            queueMaxWaitMs: 60 * 60_000
          },
          profileId: action.profileId,
          proxySelection: action.proxySelection ?? { mode: "profile-default" },
          triggerSource: {
            kind: "early-gate",
            parentTaskId: parent.id,
            gateType: event.type,
            gateSource: event.source,
            observedAt
          },
          postQueueDiscovery: {
            productName: strategy.productName,
            keywords: [...strategy.discoveryKeywords]
          }
        }
      };

      const child = this.orchestrator.createTask(childConfig);
      setEarlyGateRuntime(parent, {
        flowId,
        activeArea: "browser-child",
        stage: "gate-detected",
        childTaskId: child.id,
        gateDetectedAt: observedAt
      });
      setEarlyGateRuntime(child, {
        flowId,
        activeArea: "browser-child",
        stage: "browser-child",
        parentTaskId: parent.id,
        childTaskId: child.id,
        productName: strategy.productName,
        keywords: strategy.discoveryKeywords,
        gateDetectedAt: observedAt,
        browserChildStartedAt: new Date().toISOString()
      });
      child.config.data = {
        ...(child.config.data ?? {}),
        earlyGateRuntime: child.config.data?.["earlyGateRuntime"]
      };
      this.copyPaymentSession(parent, child, action);

      this.orchestrator.cancelTask(parent.id);
      void this.orchestrator.startTask(child.id);
      this.options.onGateTriggered?.(parent, child, event);
      return child;
    } catch (error) {
      this.triggeredParents.delete(parent.id);
      parent.lastError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  private copyPaymentSession(parent: Task, child: Task, action: AutoCheckoutActionConfig): void {
    const paymentSession = action.paymentEnabled
      ? this.options.getPaymentSession?.(parent.id)
      : undefined;
    if (!paymentSession) return;
    this.options.setPaymentSession?.(child.id, {
      ...paymentSession,
      card: paymentSession.card ? { ...paymentSession.card } : undefined
    });
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
