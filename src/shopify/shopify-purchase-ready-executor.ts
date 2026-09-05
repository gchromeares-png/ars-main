import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { AresProfile } from "../profiles/models";
import type { CheckoutPaymentSession, PaymentPreparationResult } from "../payments/models";
import type { Page } from "../browser-worker/types";
import {
  SemanticCheckoutPreparer,
  type SemanticCheckoutPreparationResult
} from "../browser-worker/semantic-checkout-preparer";
import { CheckoutPaymentPreparer } from "../browser-worker/checkout-payment-preparer";
import { ShopifyCheckoutJourney } from "./checkout-journey";

interface ShopifyCheckoutBaseExecutor {
  execute(task: Task): Promise<boolean>;
  closeTask(taskId: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface BrowserContextLookup {
  getContext(taskId: string): { page: Page } | undefined;
}

interface CheckoutProfilePreparer {
  prepare(page: Page, profile: AresProfile): Promise<SemanticCheckoutPreparationResult>;
}

interface PaymentPreparer {
  prepare(page: Page, session?: CheckoutPaymentSession): Promise<PaymentPreparationResult>;
}

interface CheckoutJourney {
  isReadyForFinalSubmit(page: Page): Promise<boolean>;
  advanceCheckout(page: Page): Promise<boolean>;
  submitOrder(page: Page, canPurchase: () => boolean): Promise<boolean>;
}

interface ActiveCheckout {
  task: Task;
  controller: AbortController;
  purchaseReady: boolean;
}

/**
 * Extends the existing Shopify executor from "checkout opened + address ready"
 * to a real purchase-ready lifecycle. Final order submission remains guarded by
 * the existing backend-wide purchase permission and is blocked by default.
 */
export class ShopifyPurchaseReadyExecutor implements ITaskExecutor {
  private readonly active = new Map<string, ActiveCheckout>();
  private allowFinalPurchase = false;

  constructor(
    private readonly delegate: ShopifyCheckoutBaseExecutor,
    private readonly runtime: BrowserContextLookup,
    private readonly onTaskUpdate: (task: Task) => void = () => undefined,
    private readonly checkoutPreparer: CheckoutProfilePreparer = new SemanticCheckoutPreparer(),
    private readonly paymentPreparer: PaymentPreparer = new CheckoutPaymentPreparer(),
    private readonly journey: CheckoutJourney = new ShopifyCheckoutJourney()
  ) {}

  async execute(
    task: Task,
    profile?: AresProfile,
    paymentSession?: CheckoutPaymentSession
  ): Promise<boolean> {
    if (!profile) {
      task.lastError = "Shopify Purchase-Ready-Flow benötigt das zugeordnete Profil.";
      return false;
    }
    if (this.active.has(task.id)) {
      task.lastError = `Shopify Checkout ${task.id} läuft bereits.`;
      return false;
    }

    const checkoutOpened = await this.delegate.execute(task);
    if (!checkoutOpened) return false;

    const page = this.runtime.getContext(task.id)?.page;
    if (!page || page.isClosed()) {
      task.lastError = "Shopify Checkout-Kontext ist nach der Profilvorbereitung nicht mehr aktiv.";
      return false;
    }

    const active: ActiveCheckout = {
      task,
      controller: new AbortController(),
      purchaseReady: false
    };
    this.active.set(task.id, active);

    try {
      this.publishFlow(task, "checkout");
      await this.prepareUntilPurchaseReady(task, active, page, profile, paymentSession);
      if (active.controller.signal.aborted) return true;

      active.purchaseReady = true;
      this.publishFlow(task, "purchase-ready");
      this.publishFinalPurchaseStatus(task, this.allowFinalPurchase ? "armed" : "blocked");

      while (!active.controller.signal.aborted) {
        if (!this.allowFinalPurchase) {
          await this.delay(250, active.controller.signal);
          continue;
        }

        const submitted = await this.journey.submitOrder(
          page,
          () => this.allowFinalPurchase && !active.controller.signal.aborted
        );
        if (submitted) {
          this.publishFlow(task, "submitted");
          this.publishFinalPurchaseStatus(task, "submitted");
          return true;
        }

        this.publishFinalPurchaseStatus(task, this.allowFinalPurchase ? "not-ready" : "blocked");
        if (!await this.journey.isReadyForFinalSubmit(page).catch(() => false)) {
          active.purchaseReady = false;
          await this.prepareUntilPurchaseReady(task, active, page, profile, paymentSession);
          if (active.controller.signal.aborted) return true;
          active.purchaseReady = true;
          this.publishFlow(task, "purchase-ready");
        }
        await this.delay(700, active.controller.signal);
      }
      return true;
    } catch (error) {
      if (active.controller.signal.aborted) return true;
      task.lastError = error instanceof Error ? error.message : String(error);
      this.onTaskUpdate(task);
      await this.delegate.closeTask(task.id).catch(() => undefined);
      return false;
    } finally {
      this.active.delete(task.id);
    }
  }

  async setFinalPurchaseAllowed(allowed: boolean): Promise<void> {
    this.allowFinalPurchase = allowed === true;
    for (const active of this.active.values()) {
      if (!active.purchaseReady) continue;
      this.publishFinalPurchaseStatus(active.task, this.allowFinalPurchase ? "armed" : "blocked");
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    this.active.get(taskId)?.controller.abort();
    this.active.delete(taskId);
    await this.delegate.closeTask(taskId);
  }

  async closeAll(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
    await this.delegate.closeAll();
  }

  private async prepareUntilPurchaseReady(
    task: Task,
    active: ActiveCheckout,
    page: Page,
    profile: AresProfile,
    paymentSession?: CheckoutPaymentSession
  ): Promise<void> {
    const deadline = Date.now() + this.checkoutPreparationMaxMs(task);
    const shopify = task.config.data?.["shopify"] as Record<string, unknown> | undefined;
    const initialProfile = shopify?.["checkoutProfile"] as Record<string, unknown> | undefined;
    let profileReady = initialProfile?.["requiredTargetsSatisfied"] === true;
    let lastProfile: SemanticCheckoutPreparationResult | undefined;
    let lastPayment: PaymentPreparationResult | undefined;

    while (!active.controller.signal.aborted && Date.now() < deadline) {
      lastProfile = await this.checkoutPreparer.prepare(page, profile).catch(() => undefined);
      if (lastProfile && lastProfile.requiredTargetCount > 0) {
        profileReady = lastProfile.requiredTargetsSatisfied;
      }

      lastPayment = await this.paymentPreparer.prepare(page, paymentSession).catch(error => ({
        detectedMethods: [],
        selectedMethod: paymentSession?.method,
        filledFields: [],
        missingFields: [],
        requiresUserAction: true,
        note: `Zahlungsprüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`
      }));

      const reviewReady = profileReady && await this.journey.isReadyForFinalSubmit(page).catch(() => false);
      this.publishCheckoutPreparation(task, {
        phase: reviewReady ? "purchase-ready" : "preparing",
        profileReady,
        reviewReady,
        profile: lastProfile,
        payment: lastPayment
      });
      if (reviewReady) return;

      const advanced = await this.journey.advanceCheckout(page).catch(() => false);
      if (!advanced) await this.delay(700, active.controller.signal);
    }

    if (active.controller.signal.aborted) return;
    const reason = !profileReady
      ? "Shopify Checkout-Adresse/Profil wurde nicht vollständig bestätigt."
      : "Shopify Checkout erreichte keinen finalen kaufbereiten Review-/Submit-Zustand.";
    throw new Error(reason);
  }

  private publishCheckoutPreparation(task: Task, input: {
    phase: "preparing" | "purchase-ready";
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
    this.onTaskUpdate(task);
  }

  private publishFlow(task: Task, stage: "checkout" | "purchase-ready" | "submitted"): void {
    const now = new Date().toISOString();
    const shopify = task.config.data?.["shopify"] as Record<string, unknown> | undefined;
    task.config.data = {
      ...(task.config.data ?? {}),
      shopifyFlow: { stage, updatedAt: now },
      ...(stage === "submitted" ? {
        shopify: { ...(shopify ?? {}), finalPaymentSubmitted: true }
      } : {})
    };
    this.onTaskUpdate(task);
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
    this.onTaskUpdate(task);
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
