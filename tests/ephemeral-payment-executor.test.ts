import { EphemeralPaymentExecutor } from "../src/payments/ephemeral-payment-executor";
import type { Task } from "../src/models";
import { TaskState } from "../src/models";

describe("EphemeralPaymentExecutor", () => {
  it("passes payment data only to the delegated task copy and strips it from runtime/persistent task state", async () => {
    let runtimeListener: ((task: Task) => void) | undefined;
    let delegatedTask: Task | undefined;

    const delegate: any = {
      onTaskUpdate: (callback: (task: Task) => void) => {
        runtimeListener = callback;
        return () => { runtimeListener = undefined; };
      },
      execute: async (task: Task) => {
        delegatedTask = task;
        expect((task.config.data as any)?.__paymentSession?.card?.securityCode).toBe("123");

        task.config.data = {
          ...(task.config.data ?? {}),
          paymentPreparation: {
            detectedMethods: ["card"],
            filledFields: ["cardNumber"],
            missingFields: [],
            requiresUserAction: true
          }
        };
        runtimeListener?.(task);
        return true;
      }
    };

    const original: Task = {
      id: "task-pay-1",
      config: {
        id: "task-pay-1",
        name: "Payment Test",
        shopId: "shop-1",
        data: { profileId: "profile-1" }
      },
      state: TaskState.RUNNING,
      createdAt: new Date(),
      updatedAt: new Date(),
      retries: 0,
      maxRetries: 0
    };

    const executor = new EphemeralPaymentExecutor(delegate, () => ({
      method: "card",
      card: {
        cardNumber: "4111111111111111",
        expiry: "12/30",
        securityCode: "123"
      }
    }));

    const updates: Task[] = [];
    executor.onTaskUpdate(task => updates.push({ ...task, config: { ...task.config, data: { ...(task.config.data ?? {}) } } }));

    const success = await executor.execute(original);

    expect(success).toBe(true);
    expect(delegatedTask).toBeDefined();
    expect((delegatedTask!.config.data as any).__paymentSession).toBeDefined();
    expect((original.config.data as any).__paymentSession).toBeUndefined();
    expect((updates[0]?.config.data as any).__paymentSession).toBeUndefined();
    expect((original.config.data as any).paymentPreparation).toBeDefined();
  });
});
