import { EphemeralPaymentExecutor } from "../src/payments/ephemeral-payment-executor";
import type { Task } from "../src/models";
import { TaskState } from "../src/models";

function task(): Task {
  return {
    id: "task-vault-fallback",
    config: {
      id: "task-vault-fallback",
      name: "Vault fallback",
      shopId: "shop-1",
      data: { profileId: "profile-card" }
    },
    state: TaskState.RUNNING,
    createdAt: new Date(),
    updatedAt: new Date(),
    retries: 0,
    maxRetries: 0
  };
}

describe("EphemeralPaymentExecutor profile fallback", () => {
  it("materializes a vault card when no task-scoped payment session exists and keeps persistent state secret-free", async () => {
    const pan = "4111111111111111";
    const securityCode = "123";
    let delegated: Task | undefined;

    const delegate: any = {
      execute: async (workerTask: Task) => {
        delegated = workerTask;
        expect((workerTask.config.data as any).__paymentSession).toEqual({
          method: "card",
          card: {
            holderName: "Vault Holder",
            cardNumber: pan,
            expiry: "12/30",
            securityCode
          }
        });
        return true;
      }
    };

    const original = task();
    const executor = new EphemeralPaymentExecutor(
      delegate,
      () => undefined,
      profileId => {
        expect(profileId).toBe("profile-card");
        return {
          method: "card",
          card: {
            holderName: "Vault Holder",
            cardNumber: pan,
            expiry: "12/30",
            securityCode
          }
        };
      }
    );

    expect(await executor.execute(original)).toBe(true);
    expect(delegated).toBeDefined();
    const persistent = JSON.stringify(original.config.data);
    expect(persistent).not.toContain("__paymentSession");
    expect(persistent).not.toContain(pan);
    expect(persistent).not.toContain(securityCode);
  });

  it("fails closed when profile materialization throws", async () => {
    const delegate: any = {
      execute: async (workerTask: Task) => {
        expect((workerTask.config.data as any).__paymentSession).toEqual({ method: "card" });
        return false;
      }
    };

    const executor = new EphemeralPaymentExecutor(
      delegate,
      () => undefined,
      () => { throw new Error("vault unavailable"); }
    );

    const original = task();
    expect(await executor.execute(original)).toBe(false);
    expect(JSON.stringify(original.config.data)).not.toContain("__paymentSession");
  });
});
