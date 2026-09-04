import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { CheckoutPaymentSession } from "./models";

type RuntimeUpdateSource = ITaskExecutor & {
  onTaskUpdate?: (callback: (task: Task) => void) => () => void;
};

const SESSION_KEY = "__paymentSession";

function sanitizedConfig(config: Task["config"]): Task["config"] {
  const data = { ...(config.data ?? {}) };
  delete data[SESSION_KEY];
  return { ...config, data };
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
    const session = this.getPaymentSession(task.id);
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
}
