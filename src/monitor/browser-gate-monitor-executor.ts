import * as os from "os";
import * as path from "path";
import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { CommerceShop } from "../commerce/platforms";
import type { AresProfile } from "../profiles/models";
import type { BrowserWorker } from "../browser-worker/browser-worker";
import { BrowserQueueWaiter } from "../browser-worker/queue-waiter";
import { getMonitorStrategy, setEarlyGateRuntime } from "./early-gate";

interface ActiveBrowserMonitor { controller: AbortController; }

export interface BrowserGateMonitorExecutorOptions {
  pollIntervalMs?: number;
  refreshIntervalMs?: number;
}

/** Lightweight browser-backed gate observer. Checkout/payment modules are intentionally absent. */
export class BrowserGateMonitorExecutor implements ITaskExecutor {
  private readonly active = new Map<string, ActiveBrowserMonitor>();
  private readonly runtimeListeners = new Set<(task: Task) => void>();
  private readonly pollIntervalMs: number;
  private readonly refreshIntervalMs: number;

  constructor(
    private readonly getShop: (shopId: string) => CommerceShop | undefined,
    private readonly getProfile: (profileId: string) => AresProfile | undefined,
    private readonly browserWorker: BrowserWorker,
    options: BrowserGateMonitorExecutorOptions = {}
  ) {
    this.pollIntervalMs = Math.min(10_000, Math.max(250, options.pollIntervalMs ?? 750));
    this.refreshIntervalMs = Math.min(60_000, Math.max(1_000, options.refreshIntervalMs ?? 5_000));
  }

  onTaskUpdate(callback: (task: Task) => void): () => void {
    this.runtimeListeners.add(callback);
    return () => this.runtimeListeners.delete(callback);
  }

  async execute(task: Task): Promise<boolean> {
    const strategy = getMonitorStrategy(task);
    const shopId = task.config.shopId;
    const profileId = String(task.config.data?.["profileId"] ?? "").trim();
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
        headless: profile.browser?.headless ?? Boolean((task.config.data?.["browserConfig"] as Record<string, unknown> | undefined)?.["headless"]),
        proxy,
        userAgent: profile.browser?.userAgent?.trim() || undefined,
        viewport: null,
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 8_000,
        monitorMode: true
      });
      const page = handle.page;
      setEarlyGateRuntime(task, {
        activeArea: "monitor", stage: "monitoring", productName: strategy.productName,
        keywords: strategy.discoveryKeywords, monitoringAt: new Date().toISOString()
      });
      task.config.data = {
        ...(task.config.data ?? {}),
        browserGateMonitor: {
          mode: "browser", profileId: profile.id, proxyBound: Boolean(proxy),
          userAgent: handle.environmentAudit.snapshot.userAgent,
          pollIntervalMs: this.pollIntervalMs, refreshIntervalMs: this.refreshIntervalMs,
          startedAt: new Date().toISOString()
        }
      };
      this.emit(task);

      const waiter = new BrowserQueueWaiter(page, task, current => this.emit(current), {
        pollIntervalMs: this.pollIntervalMs, releaseConfirmations: 2, maxWaitMs: 60 * 60_000
      });
      waiter.start();
      try {
        await page.goto(shop.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        while (!controller.signal.aborted) {
          const queue = await waiter.waitIfQueued();
          if (queue.detected) {
            const status = task.config.data?.["queueStatus"] as Record<string, unknown> | undefined;
            const detectedAt = String(status?.["detectedAt"] ?? new Date().toISOString());
            setEarlyGateRuntime(task, { activeArea: "gate", stage: "gate-detected", gateDetectedAt: detectedAt });
            task.config.data = {
              ...(task.config.data ?? {}),
              browserGateHandoff: {
                type: "queue-signal", shopId, observedAt: detectedAt,
                source: `browser-${String(status?.["source"] ?? "combined")}`,
                position: status?.["position"], timeToWaitSeconds: status?.["timeToWaitSeconds"],
                statusText: status?.["statusText"], released: queue.released,
                readyAt: new Date().toISOString()
              }
            };
            this.emit(task);
            return true;
          }
          await this.delay(this.refreshIntervalMs, controller.signal);
          if (!controller.signal.aborted) {
            await page.goto(shop.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
          }
        }
        return true;
      } finally { waiter.stop(); }
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

  private emit(task: Task): void { for (const listener of this.runtimeListeners) listener(task); }
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
