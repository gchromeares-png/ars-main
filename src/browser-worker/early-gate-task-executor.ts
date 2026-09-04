import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { CommerceShop } from "../commerce/platforms";
import type { AresProfile } from "../profiles/models";
import type { BrowserWorker } from "./browser-worker";
import { PatchrightBrowserWorker } from "./patchright-browser-worker";
import { BrowserQueueWaiter } from "./queue-waiter";
import { normalizeDiscoveryKeywords, setEarlyGateRuntime } from "../monitor/early-gate";
import type { ReleaseJourney } from "../commerce/release-discovery/release-journey";

interface ActiveDiscoverySession {
  task: Task;
  keywords: string[];
  controller: AbortController;
}

export class EarlyGateBrowserTaskExecutor implements ITaskExecutor {
  private readonly active = new Map<string, ActiveDiscoverySession>();

  constructor(
    private readonly getShop: (shopId: string) => CommerceShop | undefined,
    private readonly getProfile: (profileId: string) => AresProfile | undefined,
    private readonly resolveJourney: (shop: CommerceShop) => ReleaseJourney | undefined,
    private readonly browserWorker: BrowserWorker = new PatchrightBrowserWorker(),
    private readonly onTaskUpdate: (task: Task) => void = () => undefined
  ) {}

  async execute(task: Task): Promise<boolean> {
    const shopId = task.config.shopId;
    const profileId = String(task.config.data?.["profileId"] ?? "").trim();
    const postQueue = task.config.data?.["postQueueDiscovery"] as Record<string, unknown> | undefined;
    const productName = String(postQueue?.["productName"] ?? "").trim();
    if (!shopId || !profileId || !productName) {
      task.lastError = "Early-Gate-Child benötigt shopId, profileId und productName.";
      return false;
    }
    const shop = this.getShop(shopId);
    const profile = this.getProfile(profileId);
    if (!shop || !profile) {
      task.lastError = !shop ? `Shop ${shopId} ist nicht registriert.` : `Profil ${profileId} ist nicht registriert.`;
      return false;
    }
    const journey = this.resolveJourney(shop);
    if (!journey?.supports(shop)) {
      task.lastError = `Für ${shop.name} ist keine Early-Gate-Release-Journey registriert.`;
      return false;
    }
    if (this.active.has(task.id)) {
      task.lastError = `Early-Gate-Browser-Task ${task.id} läuft bereits.`;
      return false;
    }

    const session: ActiveDiscoverySession = {
      task,
      keywords: normalizeDiscoveryKeywords(postQueue?.["keywords"]),
      controller: new AbortController()
    };
    this.active.set(task.id, session);

    const profileRoot = process.env["ARES_BROWSER_PROFILE_ROOT"]?.trim() || path.join(os.tmpdir(), "ares-browser-profiles");
    fs.mkdirSync(profileRoot, { recursive: true });
    const userDataDir = path.join(profileRoot, task.id.replace(/[^a-zA-Z0-9_-]/g, "_"));
    fs.mkdirSync(userDataDir, { recursive: true });
    const proxy = profile.proxy?.host && profile.proxy.port ? {
      protocol: profile.proxy.protocol || "http" as const,
      host: profile.proxy.host,
      port: profile.proxy.port,
      username: profile.proxy.username || undefined,
      password: profile.proxy.password || undefined
    } : undefined;

    try {
      await this.browserWorker.closeContext(task.id);
      const handle = await this.browserWorker.createContext({
        taskId: task.id,
        userDataDir,
        headless: profile.browser?.headless ?? Boolean((task.config.data?.["browserConfig"] as Record<string, unknown> | undefined)?.["headless"]),
        proxy,
        userAgent: profile.browser?.userAgent || undefined,
        viewport: null,
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 15_000
      });
      const page = handle.page;
      task.config.data = {
        ...(task.config.data ?? {}),
        browserSession: { type: "patchright-chromium", isolatedPerTask: true, userDataDir }
      };
      setEarlyGateRuntime(task, { activeArea: "browser-child", stage: "browser-child" });
      this.emit(task);

      const waiter = new BrowserQueueWaiter(page, task, current => this.emit(current), {
        maxWaitMs: this.queueMaxWaitMs(task),
        pollIntervalMs: 2_000,
        releaseConfirmations: 2
      });
      waiter.start();
      let navigationError: unknown;
      try {
        await page.goto(shop.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (error) {
        navigationError = error;
      }
      try {
        const queue = await waiter.waitIfQueued();
        if (!queue.detected && navigationError) throw navigationError;
      } finally {
        waiter.stop();
      }

      this.markStage(task, "post-queue-discovery", {
        postQueueDiscoveryAt: new Date().toISOString()
      });
      this.publishKeywords(session);

      const discoveryDeadline = Date.now() + this.discoveryMaxMs(task);
      let product;
      while (!session.controller.signal.aborted && Date.now() < discoveryDeadline) {
        product = await journey.discover(page, shop, {
          productName,
          keywords: [...session.keywords]
        });
        if (product) break;
        await this.delay(this.discoveryIntervalMs(task), session.controller.signal);
      }
      if (session.controller.signal.aborted) return true;
      if (!product) throw new Error("Post-Queue-Discovery-Zeitfenster ohne passenden verfügbaren Produkt-Treffer beendet.");

      task.config.data = {
        ...(task.config.data ?? {}),
        releaseProduct: {
          title: product.title,
          url: product.url,
          externalId: product.externalId,
          sku: product.sku
        }
      };
      this.markStage(task, "product-found", { productFoundAt: new Date().toISOString() });

      await journey.addToCart(page, shop, product);
      this.markStage(task, "cart", { cartAt: new Date().toISOString() });

      await journey.openCheckout(page, shop);
      this.markStage(task, "checkout", { checkoutAt: new Date().toISOString() });
      return true;
    } catch (error) {
      if (session.controller.signal.aborted) return true;
      task.lastError = error instanceof Error ? error.message : String(error);
      this.emit(task);
      await this.browserWorker.closeContext(task.id).catch(() => undefined);
      return false;
    } finally {
      this.active.delete(task.id);
    }
  }

  updateDiscoveryKeywords(taskId: string, keywords: unknown): string[] {
    const session = this.active.get(taskId);
    if (!session) throw new Error(`Laufender Early-Gate-Browser-Child ${taskId} wurde nicht gefunden.`);
    session.keywords = normalizeDiscoveryKeywords(keywords);
    this.publishKeywords(session);
    return [...session.keywords];
  }

  async cancelTask(taskId: string): Promise<void> {
    this.active.get(taskId)?.controller.abort();
    this.active.delete(taskId);
    await this.browserWorker.closeContext(taskId);
  }

  async closeAll(): Promise<void> {
    for (const session of this.active.values()) session.controller.abort();
    this.active.clear();
    if (this.browserWorker instanceof PatchrightBrowserWorker) await this.browserWorker.shutdown();
  }

  private publishKeywords(session: ActiveDiscoverySession): void {
    const now = new Date().toISOString();
    session.task.config.data = {
      ...(session.task.config.data ?? {}),
      postQueueDiscovery: {
        ...((session.task.config.data?.["postQueueDiscovery"] as Record<string, unknown> | undefined) ?? {}),
        keywords: [...session.keywords],
        updatedAt: now
      }
    };
    setEarlyGateRuntime(session.task, { keywords: [...session.keywords], activeArea: "browser-child" });
    this.emit(session.task);
  }

  private markStage(task: Task, stage: "post-queue-discovery" | "product-found" | "cart" | "checkout", timestamps: Record<string, string>): void {
    task.config.data = {
      ...(task.config.data ?? {}),
      earlyGateFlow: { stage, updatedAt: new Date().toISOString() }
    };
    setEarlyGateRuntime(task, { activeArea: "browser-child", stage, ...timestamps });
    this.emit(task);
  }

  private emit(task: Task): void {
    this.onTaskUpdate(task);
  }

  private queueMaxWaitMs(task: Task): number {
    const data = task.config.data ?? {};
    const browserConfig = data["browserConfig"] as Record<string, unknown> | undefined;
    const raw = Number(browserConfig?.["queueMaxWaitMs"] ?? data["queueMaxWaitMs"] ?? 60 * 60_000);
    return Number.isFinite(raw) ? Math.min(60 * 60_000, Math.max(1_000, raw)) : 60 * 60_000;
  }

  private discoveryMaxMs(task: Task): number {
    const raw = Number(task.config.data?.["discoveryMaxMs"] ?? 45 * 60_000);
    return Number.isFinite(raw) ? Math.min(60 * 60_000, Math.max(60_000, raw)) : 45 * 60_000;
  }

  private discoveryIntervalMs(task: Task): number {
    const raw = Number(task.config.data?.["discoveryIntervalMs"] ?? 3_000);
    return Number.isFinite(raw) ? Math.min(30_000, Math.max(1_000, raw)) : 3_000;
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
