import * as os from "os";
import * as path from "path";
import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { CommerceShop } from "../commerce/platforms";
import type { AresProfile } from "../profiles/models";
import type { BrowserWorker } from "../browser-worker/browser-worker";
import { BrowserQueueWaiter } from "../browser-worker/queue-waiter";
import { getMonitorStrategy, setEarlyGateRuntime, type PreCheckoutGateEvent } from "./early-gate";

interface ActiveBrowserMonitor {
  controller: AbortController;
}

export interface BrowserGateMonitorExecutorOptions {
  pollIntervalMs?: number;
  onGateEvent?: (taskId: string, event: PreCheckoutGateEvent) => void;
}

/**
 * Lightweight browser-backed Early-Gate monitor.
 *
 * It intentionally owns only gate observation. Checkout, semantic autofill,
 * payment preparation and final-submit logic remain in the separate browser
 * child executor. The monitor uses the selected profile/proxy/user-agent so
 * JS-rendered/browser-bound gates are visible without loading checkout modules.
 */
export class BrowserGateMonitorExecutor implements ITaskExecutor {
  private readonly active = new Map<string, ActiveBrowserMonitor>();
  private readonly runtimeListeners = new Set<(task: Task) => void>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly getShop: (shopId: string) => CommerceShop | undefined,
    private readonly getProfile: (profileId: string) => AresProfile | undefined,
    private readonly browserWorker: BrowserWorker,
    private readonly options: BrowserGateMonitorExecutorOptions = {}
  ) {
    this.pollIntervalMs = Math.min(10_000, Math.max(250, options.pollIntervalMs ?? 750));
  }

  onTaskUpdate(callback: (task: Task) => void): () => void {
    this.runtimeListeners.add(callback);
    return () => this.runtimeListeners.delete(callback);
  }

  async execute(task: Task): Promise<boolean> {
    const strategy = getMonitorStrategy(task);
    const shopId = task.config.shopId;
    const action = task.config.data?.["monitorAction"] as Record<string, unknown> | undefined;
    const profileId = String(action?.["profileId"] ?? task.config.data?.["profileId"] ?? "").trim();
    if (strategy.mode !== "early-gate" || !shopId || !profileId) {
      task.lastError = "Browser-Gate-Monitor benötigt Early-Gate, shopId und profileId.";
      return false;
    }
    const shop = this.getShop(shopId);
    const profile = this.getProfile(profileId);
    if (!shop || !profile) {
      task.lastError = !shop ? `Shop ${shopId} ist nicht registriert.` : `Profil ${profileId} ist nicht registriert.`;
      return false;
    }
    if (this.active.has(task.id)) {
      task.lastError = `Browser-Gate-Monitor ${task.id} läuft bereits.`;
      return false;
    }

    const controller = new AbortController();
    this.active.set(task.id, { controller });
    const profileRoot = process.env["ARES_BROWSER_PROFILE_ROOT"]?.trim() || path.join(os.tmpdir(), "ares-browser-profiles");
    const userDataDir = path.join(profileRoot, profile.id.replace(/[^a-zA-Z0-9_-]/g, "_"));
    const proxy = profile.proxy?.host && profile.proxy.port ? {
      protocol: profile.proxy.protocol || "http" as const,
      host: profile.proxy.host,
      port: profile.proxy.port,
      username: profile.proxy.username || undefined,
      password: profile.proxy.password || undefined
    } : undefined;

    try {
      const handle = await this.browserWorker.createContext({
        taskId: task.id,
        userDataDir,
        headless: profile.browser?.headless ?? Boolean(action?.["headless"]),
        proxy,
        userAgent: profile.browser?.userAgent?.trim() || undefined,
        viewport: null,
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 8_000,
        monitorMode: true
      });
      const page = handle.page;
      setEarlyGateRuntime(task, {
        activeArea: "monitor",
        stage: "monitoring",
        productName: strategy.productName,
        keywords: strategy.discoveryKeywords,
        monitoringAt: new Date().toISOString()
      });
      task.config.data = {
        ...(task.config.data ?? {}),
        browserGateMonitor: {
          mode: "browser",
          profileId: profile.id,
          proxyBound: Boolean(proxy),
          userAgent: handle.environmentAudit.snapshot.userAgent,
          pollIntervalMs: this.pollIntervalMs,
          startedAt: new Date().toISOString()
        }
      };
      this.emit(task);

      const waiter = new BrowserQueueWaiter(page, task, current => this.emit(current), {
        pollIntervalMs: this.pollIntervalMs,
        releaseConfirmations: 2,
        maxWaitMs: 60 * 60_000
      });
      waiter.start();
      let navigationError: unknown;
      try {
        await page.goto(shop.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (error) {
        navigationError = error;
      }

      const queue = await waiter.waitIfQueued();
      waiter.stop();
      if (!queue.detected) {
        if (navigationError) throw navigationError;
        throw new Error("Browser-Monitor hat beim Start kein Gate erkannt.");
      }

      const queueStatus = task.config.data?.["queueStatus"] as Record<string, unknown> | undefined;
      const observedAt = new Date(String(queueStatus?.["detectedAt"] ?? new Date().toISOString()));
      const event: PreCheckoutGateEvent = {
        type: "queue-signal",
        shopId,
        observedAt: Number.isNaN(observedAt.getTime()) ? new Date() : observedAt,
        source: `browser-${String(queueStatus?.["source"] ?? "combined")}`,
        position: typeof queueStatus?.["position"] === "number" ? queueStatus["position"] as number : undefined,
        timeToWaitSeconds: typeof queueStatus?.["timeToWaitSeconds"] === "number" ? queueStatus["timeToWaitSeconds"] as number : undefined,
        statusText: typeof queueStatus?.["statusText"] === "string" ? queueStatus["statusText"] as string : undefined
      };
      setEarlyGateRuntime(task, { activeArea: "gate", stage: "gate-detected", gateDetectedAt: event.observedAt.toISOString() });
      this.emit(task);
      this.options.onGateEvent?.(task.id, event);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return true;
      task.lastError = error instanceof Error ? error.message : String(error);
      this.emit(task);
      return false;
    } finally {
      this.active.delete(task.id);
      await this.browserWorker.closeContext(task.id).catch(() => undefined);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    this.active.get(taskId)?.controller.abort();
    this.active.delete(taskId);
    await this.browserWorker.closeContext(taskId).catch(() => undefined);
  }

  async close(): Promise<void> {
    const ids = [...this.active.keys()];
    for (const run of this.active.values()) run.controller.abort();
    this.active.clear();
    await Promise.allSettled(ids.map(id => this.browserWorker.closeContext(id)));
    this.runtimeListeners.clear();
  }

  private emit(task: Task): void {
    for (const listener of this.runtimeListeners) listener(task);
  }
}
