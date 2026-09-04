import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EphemeralPaymentExecutor } from "../src/payments/ephemeral-payment-executor";
import { ProfilePaymentVault, type PaymentVaultCrypto } from "../src/payments/profile-payment-vault";
import type { Task } from "../src/models";
import { TaskState } from "../src/models";

function testCrypto(): PaymentVaultCrypto {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${Buffer.from(value, "utf8").toString("base64")}`, "utf8"),
    decryptString: value => Buffer.from(value.toString("utf8").replace(/^enc:/, ""), "base64").toString("utf8")
  };
}

describe("EphemeralPaymentExecutor", () => {
  it("passes payment session data only to the delegated task copy and strips it from runtime/persistent task state", async () => {
    let runtimeListener: ((task: Task) => void) | undefined;
    let delegatedTask: Task | undefined;

    const delegate: any = {
      onTaskUpdate: (callback: (task: Task) => void) => {
        runtimeListener = callback;
        return () => { runtimeListener = undefined; };
      },
      execute: async (task: Task) => {
        delegatedTask = task;
        expect((task.config.data as any)?.__paymentSession).toEqual({
          method: "paypal",
          label: "Primary PayPal"
        });

        task.config.data = {
          ...(task.config.data ?? {}),
          paymentPreparation: {
            detectedMethods: ["paypal"],
            filledFields: [],
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
      method: "paypal",
      label: "Primary PayPal"
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

  it("loads card secrets from the profile vault only for the delegated worker task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ares-ephemeral-card-"));
    const vaultPath = path.join(root, "payment-vault.json");
    const pan = Array.from({ length: 16 }, () => "4").join("");
    const securityCode = ["1", "2", "3"].join("");

    try {
      const vault = new ProfilePaymentVault(vaultPath, testCrypto());
      vault.save("profile-card", {
        holderName: "Vault Holder",
        cardNumber: pan,
        expiryMonth: "12",
        expiryYear: "2030",
        securityCode
      });

      let delegatedSnapshot = "";
      let runtimeListener: ((task: Task) => void) | undefined;
      const delegate: any = {
        onTaskUpdate: (callback: (task: Task) => void) => {
          runtimeListener = callback;
          return () => { runtimeListener = undefined; };
        },
        execute: async (task: Task) => {
          delegatedSnapshot = JSON.stringify(task.config.data);
          const session = (task.config.data as any).__paymentSession;
          expect(session.card).toEqual({
            holderName: "Vault Holder",
            cardNumber: pan,
            expiry: "12/30",
            securityCode
          });

          runtimeListener?.({
            ...task,
            config: {
              ...task.config,
              data: {
                ...(task.config.data ?? {}),
                paymentPreparation: {
                  selectedMethod: "card",
                  filledFields: ["holderName", "cardNumber", "expiry", "securityCode"],
                  missingFields: [],
                  requiresUserAction: true
                }
              }
            }
          });
          return true;
        }
      };

      const original: Task = {
        id: "task-card-1",
        config: {
          id: "task-card-1",
          name: "Vault Card Test",
          shopId: "shop-1",
          data: { profileId: "profile-card" }
        },
        state: TaskState.RUNNING,
        createdAt: new Date(),
        updatedAt: new Date(),
        retries: 0,
        maxRetries: 0
      };

      const executor = new EphemeralPaymentExecutor(
        delegate,
        () => ({
          method: "card",
          card: {
            holderName: "Ignored Manual Holder",
            cardNumber: Array.from({ length: 16 }, () => "5").join(""),
            expiry: "01/29",
            securityCode: "999"
          }
        }),
        (profileId, preference) => vault.toCheckoutPaymentSession(profileId, preference)
      );

      const runtimeSnapshots: string[] = [];
      executor.onTaskUpdate(task => runtimeSnapshots.push(JSON.stringify(task.config.data)));

      expect(await executor.execute(original)).toBe(true);
      expect(delegatedSnapshot).toContain(pan);
      expect(delegatedSnapshot).toContain(securityCode);

      const persistentSnapshot = JSON.stringify(original.config.data);
      expect(persistentSnapshot).not.toContain("__paymentSession");
      expect(persistentSnapshot).not.toContain(pan);
      expect(persistentSnapshot).not.toContain(securityCode);
      for (const snapshot of runtimeSnapshots) {
        expect(snapshot).not.toContain("__paymentSession");
        expect(snapshot).not.toContain(pan);
        expect(snapshot).not.toContain(securityCode);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
