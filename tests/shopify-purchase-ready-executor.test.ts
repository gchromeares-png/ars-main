import { ShopifyPurchaseReadyExecutor } from "../src/shopify/shopify-purchase-ready-executor";
import type { Task } from "../src/models";

function task(): Task {
  return {
    id: "shopify-ready-test",
    config: {
      id: "shopify-ready-test",
      name: "Shopify purchase ready",
      shopId: "shopify-test",
      maxRetries: 0,
      data: {
        shopify: {
          checkoutProfile: { requiredTargetsSatisfied: true },
          finalPaymentSubmitted: false
        },
        checkoutPreparationMaxMs: 30_000
      }
    },
    state: "RUNNING" as any,
    retries: 0,
    maxRetries: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  } as Task;
}

describe("ShopifyPurchaseReadyExecutor", () => {
  it("holds a purchase-ready checkout open while final purchase is blocked", async () => {
    const currentTask = task();
    const page = { isClosed: jest.fn().mockReturnValue(false) } as any;
    const delegate = {
      execute: jest.fn().mockResolvedValue(true),
      closeTask: jest.fn().mockResolvedValue(undefined),
      closeAll: jest.fn().mockResolvedValue(undefined)
    };
    const runtime = { getContext: jest.fn().mockReturnValue({ page }) };
    const profilePreparer = {
      prepare: jest.fn().mockResolvedValue({
        filled: [], missing: [], writeCounts: {}, billingMode: "same-as-shipping",
        requiredTargetsSatisfied: false, requiredTargetCount: 0
      })
    };
    const paymentPreparer = {
      prepare: jest.fn().mockResolvedValue({
        detectedMethods: ["card"], selectedMethod: "card", filledFields: ["cardNumber", "expiry", "securityCode"],
        missingFields: [], requiresUserAction: true, note: "prepared"
      })
    };
    const journey = {
      isReadyForFinalSubmit: jest.fn().mockResolvedValue(true),
      advanceCheckout: jest.fn().mockResolvedValue(false),
      submitOrder: jest.fn(async (_page: unknown, guard: () => boolean) => guard())
    };

    let releaseBlocked!: () => void;
    const blocked = new Promise<void>(resolve => { releaseBlocked = resolve; });
    const onUpdate = jest.fn((updated: Task) => {
      const runtimeStatus = updated.config.data?.["finalPurchaseRuntime"] as Record<string, unknown> | undefined;
      if (runtimeStatus?.["status"] === "blocked") releaseBlocked();
    });

    const executor = new ShopifyPurchaseReadyExecutor(
      delegate,
      runtime,
      onUpdate,
      profilePreparer,
      paymentPreparer,
      journey
    );

    const execution = executor.execute(currentTask, { id: "profile", name: "Profile" } as any, { method: "card" });
    await blocked;

    expect(journey.submitOrder).not.toHaveBeenCalled();
    expect((currentTask.config.data?.["finalPurchaseRuntime"] as any)?.status).toBe("blocked");
    expect((currentTask.config.data?.["checkoutPreparation"] as any)?.reviewReady).toBe(true);

    await executor.setFinalPurchaseAllowed(true);
    await expect(execution).resolves.toBe(true);

    expect(journey.submitOrder).toHaveBeenCalledTimes(1);
    expect((currentTask.config.data?.["finalPurchaseRuntime"] as any)?.status).toBe("submitted");
    expect((currentTask.config.data?.["shopify"] as any)?.finalPaymentSubmitted).toBe(true);
    expect(delegate.closeTask).not.toHaveBeenCalled();
  });

  it("advances checkout sections before accepting purchase-ready state", async () => {
    const currentTask = task();
    const page = { isClosed: jest.fn().mockReturnValue(false) } as any;
    const delegate = {
      execute: jest.fn().mockResolvedValue(true),
      closeTask: jest.fn().mockResolvedValue(undefined),
      closeAll: jest.fn().mockResolvedValue(undefined)
    };
    const runtime = { getContext: jest.fn().mockReturnValue({ page }) };
    const profilePreparer = {
      prepare: jest.fn().mockResolvedValue({
        filled: [], missing: [], writeCounts: {}, billingMode: "same-as-shipping",
        requiredTargetsSatisfied: false, requiredTargetCount: 0
      })
    };
    const paymentPreparer = {
      prepare: jest.fn().mockResolvedValue({
        detectedMethods: [], selectedMethod: undefined, filledFields: [], missingFields: [], requiresUserAction: true
      })
    };
    const journey = {
      isReadyForFinalSubmit: jest.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      advanceCheckout: jest.fn().mockResolvedValue(true),
      submitOrder: jest.fn(async (_page: unknown, guard: () => boolean) => guard())
    };
    const executor = new ShopifyPurchaseReadyExecutor(
      delegate,
      runtime,
      () => undefined,
      profilePreparer,
      paymentPreparer,
      journey
    );

    await executor.setFinalPurchaseAllowed(true);
    await expect(executor.execute(currentTask, { id: "profile", name: "Profile" } as any)).resolves.toBe(true);

    expect(journey.advanceCheckout).toHaveBeenCalledTimes(1);
    expect(journey.submitOrder).toHaveBeenCalledTimes(1);
  });
});
