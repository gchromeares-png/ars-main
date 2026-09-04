import * as path from "path";
import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { CheckoutPaymentSession } from "./models";
import { ProfilePaymentVault } from "./profile-payment-vault";

type RuntimeUpdateSource = ITaskExecutor & {
  onTaskUpdate?: (callback: (task: Task) => void) => () => void;
};

const SESSION_KEY = "__paymentSession";

function sanitizedConfig(config: Task["config"]): Task["config"] {
  const data = { ...(config.data ?? {}) };
  delete data[SESSION_KEY];
  return { ...config, data };
}

function taskProfileId(task: Task): string {
  const data = task.config.data ?? {};
  const action = data["monitorAction"] as { profileId?: string } | undefined;
  return String(data["profileId"] ?? action?.profileId ?? "").trim();
}

export class EphemeralPaymentExecutor implements ITaskExecutor {
  private readonly listeners = new Set<(task: Task) => void>();
  private readonly taskRefs = new Map<string, Task>();
  private readonly unsubscribe?: () => void;

  constructor(
    private readonly delegate: ITaskExecutor,
    private readonly getPaymentSession: (taskId: string) => CheckoutPaymentSession | undefined
  ) {
    const runtimeSource = delegate as RuntimeUpdateSource;
    this.unsubscribe = runtimeSource.onTaskUpdate?.(workerTask => {
      const task = this.taskRefs.get(workerTask.id);
      if (!task) return;
      task.config = sanitizedConfig(workerTask.config);
      task.lastError = workerTask.lastError;
      for (const listener of this.listeners) listener(task);
    });
  }

  onTaskUpdate(callback: (task: Task) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async execute(task: Task): Promise<boolean> {
    const session = this.resolveProfilePaymentSession(task, this.getPaymentSession(task.id));
    const workerTask: Task = {
      ...task,
      config: {
        ...task.config,
        data: {
          ...(task.config.data ?? {}),
          ...(session ? { [SESSION_KEY]: session } : {})
        }
      }
    };

    this.taskRefs.set(task.id, task);
    try {
      const success = await this.delegate.execute(workerTask);
      task.config = sanitizedConfig(workerTask.config);
      task.lastError = workerTask.lastError;
      return success;
    } finally {
      this.taskRefs.delete(task.id);
    }
  }

  async updateDiscoveryKeywords(taskId: string, keywords: string[]): Promise<string[]> {
    if (!this.delegate.updateDiscoveryKeywords) {
      throw new Error("Dieser Browser-Executor unterstützt keine Live-Discovery-Keywords.");
    }
    return this.delegate.updateDiscoveryKeywords(taskId, keywords);
  }

  async setFinalPurchaseAllowed(allowed: boolean): Promise<void> {
    await this.delegate.setFinalPurchaseAllowed?.(allowed === true);
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.delegate.cancelTask?.(taskId);
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.listeners.clear();
    this.taskRefs.clear();
    await this.delegate.close?.();
  }

  private resolveProfilePaymentSession(
    task: Task,
    session: CheckoutPaymentSession | undefined
  ): CheckoutPaymentSession | undefined {
    if (!session || session.method !== "card") return session;

    const profileId = taskProfileId(task);
    const profileOnlySession: CheckoutPaymentSession = {
      method: "card",
      label: session.label
    };

    // Profile-backed card data is authoritative. Any card secret that may still
    // exist in an old/manual task payload is deliberately ignored.
    if (!profileId) return profileOnlySession;

    try {
      // This wrapper runs in Electron main. Decryption remains out of Angular and
      // the external browser worker receives plaintext only for this one task.
      const electron = require("electron") as typeof import("electron");
      if (!electron.safeStorage?.isEncryptionAvailable?.()) return profileOnlySession;
      const userDataRoot = electron.app.getPath("userData");
      const vault = new ProfilePaymentVault(
        path.join(userDataRoot, "payment-vault.json"),
        {
          isEncryptionAvailable: () => electron.safeStorage.isEncryptionAvailable(),
          encryptString: value => electron.safeStorage.encryptString(value),
          decryptString: value => electron.safeStorage.decryptString(value)
        }
      );
      return vault.toCheckoutPaymentSession(profileId, {
        method: "card",
        label: session.label
      });
    } catch {
      // Fail closed: no plaintext/manual fallback. Payment preparation will report
      // missing card fields and leave the checkout waiting for user action.
      return profileOnlySession;
    }
  }
}
