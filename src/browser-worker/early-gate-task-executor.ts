import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { CommerceShop } from "../commerce/platforms";
import type { AresProfile } from "../profiles/models";
import type { CheckoutPaymentSession, PaymentPreparationResult } from "../payments/models";
import type { BrowserWorker } from "./browser-worker";
import type { Page } from "./types";
import { BrowserQueueWaiter } from "./queue-waiter";
import { CheckoutPaymentPreparer } from "./checkout-payment-preparer";
import { SemanticCheckoutPreparer, type SemanticCheckoutPreparationResult } from "./semantic-checkout-preparer";
import { normalizeDiscoveryKeywords, setEarlyGateRuntime } from "../monitor/early-gate";
import type { ReleaseJourney } from "../commerce/release-discovery/release-journey";

interface ActiveDiscoverySession {
  task: Task;
  keywords: string[];
  controller: AbortController;
}

export class EarlyGateBrowserTaskExecutor implements ITaskExecutor {
  private readonly active = new Map<string, ActiveDiscoverySession>();
  private readonly checkoutPreparer = new SemanticCheckoutPreparer();
  private readonly paymentPreparer = new CheckoutPaymentPreparer();
  private allowFinalPurchase = false;

  constructor(
    private readonly getShop: (shopId: string) => CommerceShop | undefined,
    private readonly getProfile: (profileId: string) => AresProfile | undefined,
    private readonly resolveJourney: (shop: CommerceShop) => ReleaseJourney | undefined,
    private readonly browserWorker: BrowserWorker,
    private readonly onTaskUpdate: (task: Task) => void = () => undefined
  ) {}

  async execute(task: Task, paymentSession?: CheckoutPaymentSession): Promise<boolean> {
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
        browserSession: { type: "seleniumbase-cdp", isolatedPerTask: true, userDataDir },
        browserEnvironment: handle.environmentAudit
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
      this.publishCheckoutPreparation(task, {
        phase: "checkout-opened",
        profileReady: false,
        reviewReady: false
      });

      await this.prepareCheckoutUntilReady(task, session, journey, page, shop, profile, paymentSession);
      if (session.controller.signal.aborted) return true;

      // CHECKOUT means purchase-ready now: profile/address was completed and the
      // final enabled submit control is present after safe checkout progression.
      this.markStage(task, "checkout", { checkoutAt: new Date().toISOString() });
      this.publishFinalPurchaseStatus(task, "blocked");

      while (!session.controller.signal.aborted) {
        if (!this.allowFinalPurchase) {
          await this.delay(250, session.controller.signal);
          continue;
        }

        // The global permission is checked again inside submitOrder immediately before click.
        const submitted = await journey.submitOrder(page, shop, () => this.allowFinalPurchase);
        if (submitted) {
          this.publishFinalPurchaseStatus(task, "submitted");
          return true;
        }

        this.publishFinalPurchaseStatus(task, this.allowFinalPurchase ? "not-ready" : "blocked");
        await this.delay(1_000, session.controller.signal);
      }
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

  async updateDiscoveryKeywords(taskId: string, keywords: string[]): Promise<string[]> {
    const session = this.active.get(taskId);
    if (!session) throw new Error(`Laufender Early-Gate-Browser-Child ${taskId} wurde nicht gefunden.`);
    session.keywords = normalizeDiscoveryKeywords(keywords);
    this.publishKeywords(session);
    return [...session.keywords];
  }

  async setFinalPurchaseAllowed(allowed: boolean): Promise<void> {
    this.allowFinalPurchase = allowed === true;
    for (const session of this.active.values()) {
      if (session.task.config.data?.["earlyGateFlow"] && this.flowStage(session.task) === "checkout") {
        this.publishFinalPurchaseStatus(session.task, this.allowFinalPurchase ? "armed" : "blocked");
      }
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    this.active.get(taskId)?.controller.abort();
    this.active.delete(taskId);
    await this.browserWorker.closeContext(taskId);
  }

  async closeAll(): Promise<void> {
    const taskIds = [...this.active.keys()];
    for (const session of this.active.values()) session.controller.abort();
    this.active.clear();
    await Promise.allSettled(taskIds.map(taskId => this.browserWorker.closeContext(taskId)));
  }

  private async prepareCheckoutUntilReady(
    task: Task,
    session: ActiveDiscoverySession,
    journey: ReleaseJourney,
    page: Page,
    shop: CommerceShop,
    profile: AresProfile,
    paymentSession?: CheckoutPaymentSession
  ): Promise<void> {
    const deadline = Date.now() + this.checkoutPreparationMaxMs(task);
    let profileReady = false;
    let lastProfile: SemanticCheckoutPreparationResult | undefined;
    let lastPayment: PaymentPreparationResult | undefined;

    while (!session.controller.signal.aborted && Date.now() < deadline) {
      lastProfile = await this.checkoutPreparer.prepare(page, profile).catch(() => undefined);
      if (lastProfile?.requiredTargetsSatisfied) profileReady = true;

      lastPayment = await this.paymentPreparer.prepare(page, paymentSession).catch(error => ({
        detectedMethods: [],
        selectedMethod: paymentSession?.method,
        filledFields: [],
        missingFields: [],
        requiresUserAction: true,
        note: `Zahlungsprüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`
      }));

      const reviewReady = profileReady && await journey.isReadyForFinalSubmit(page, shop);
      this.publishCheckoutPreparation(task, {
        phase: reviewReady ? "purchase-ready" : "preparing",
        profileReady,
        reviewReady,
        profile: lastProfile,
        payment: lastPayment
      });
      if (reviewReady) return;

      const advanced = await journey.advanceCheckout(page, shop).catch(() => false);
      if (!advanced) await this.delay(700, session.controller.signal);
    }

    if (session.controller.signal.aborted) return;
    const reason = !profileReady
      ? "Checkout-Adresse/Profil wurde nicht vollständig bestätigt."
      : "Finaler kaufbereiter Review-/Submit-Zustand wurde nicht erreicht.";
    throw new Error(reason);
  }

  private publishCheckoutPreparation(task: Task, input: {
    phase: "checkout-opened" | "preparing" | "purchase-ready";
    profileReady: boolean;
    reviewReady: boolean;
    profile?: SemanticCheckoutPreparationResult;
    payment?: PaymentPreparationResult;
  }): void {
    task.config.data = {
      ...(task.config.data ?? {}),
      checkoutPreparation: {
        phase: input.phase,
        profileReady: input.profileReady,
        reviewReady: input.reviewReady,
        ...(input.profile ? {
          profile: {
            billingMode: input.profile.billingMode,
            requiredTargetsSatisfied: input.profile.requiredTargetsSatisfied,
            requiredTargetCount: input.profile.requiredTargetCount,
            filled: input.profile.filled,
            missing: input.profile.missing,
            writeCounts: input.profile.writeCounts
          }
        } : {}),
        ...(input.payment ? { payment: input.payment } : {}),
        updatedAt: new Date().toISOString()
      },
      ...(input.payment ? { paymentPreparation: input.payment } : {})
    };
    this.emit(task);
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

  private publishFinalPurchaseStatus(task: Task, status: "blocked" | "armed" | "not-ready" | "submitted"): void {
    const now = new Date().toISOString();
    task.config.data = {
      ...(task.config.data ?? {}),
      finalPurchaseRuntime: {
        allowFinalPurchase: this.allowFinalPurchase,
        status,
        updatedAt: now,
        ...(status === "submitted" ? { submittedAt: now } : {})
      }
    };
    this.emit(task);
  }

  private markStage(task: Task, stage: "post-queue-discovery" | "product-found" | "cart" | "checkout", timestamps: Record<string, string>): void {
    task.config.data = {
      ...(task.config.data ?? {}),
      earlyGateFlow: { stage, updatedAt: new Date().toISOString() }
    };
    setEarlyGateRuntime(task, { activeArea: "browser-child", stage, ...timestamps });
    this.emit(task);
  }

  private flowStage(task: Task): string {
    const flow = task.config.data?.["earlyGateFlow"] as Record<string, unknown> | undefined;
    return String(flow?.["stage"] ?? "");
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

  private checkoutPreparationMaxMs(task: Task): number {
    const raw = Number(task.config.data?.["checkoutPreparationMaxMs"] ?? 10 * 60_000);
    return Number.isFinite(raw) ? Math.min(30 * 60_000, Math.max(30_000, raw)) : 10 * 60_000;
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
