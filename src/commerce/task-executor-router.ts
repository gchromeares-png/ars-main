import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import { isCommerceMonitorTask } from "../monitor/commerce-monitor-service";
import type { CommercePlatform, CommerceShop } from "./platforms";

export class CommerceTaskExecutorRouter implements ITaskExecutor {
  private readonly executors = new Map<CommercePlatform, ITaskExecutor>();
  private readonly taskOwners = new Map<string, ITaskExecutor>();
  private monitorExecutor?: ITaskExecutor;

  constructor(private readonly getShop: (shopId: string) => CommerceShop | undefined) {}

  register(platform: CommercePlatform, executor: ITaskExecutor): void {
    this.executors.set(platform, executor);
  }

  registerMonitorExecutor(executor: ITaskExecutor): void {
    this.monitorExecutor = executor;
  }

  hasExecutor(platform: CommercePlatform): boolean {
    return this.executors.has(platform);
  }

  hasMonitorExecutor(): boolean {
    return Boolean(this.monitorExecutor);
  }

  listExecutorPlatforms(): CommercePlatform[] {
    return [...this.executors.keys()];
  }

  async execute(task: Task): Promise<boolean> {
    const shopId = task.config.shopId;
    if (!shopId) {
      task.lastError = "Task hat keine shopId.";
      return false;
    }

    const shop = this.getShop(shopId);
    if (!shop) {
      task.lastError = `Shop ${shopId} ist nicht registriert.`;
      return false;
    }

    const executor = isCommerceMonitorTask(task)
      ? this.monitorExecutor
      : this.executors.get(shop.platform);

    if (!executor) {
      task.lastError = isCommerceMonitorTask(task)
        ? "Für Monitoring ist noch kein CommerceMonitorService registriert."
        : `Für ${shop.platform} ist noch kein Task-Executor registriert. Die Plattform ist bereits im Commerce-/Monitor-Modell vorbereitet.`;
      return false;
    }

    this.taskOwners.set(task.id, executor);
    try {
      return await executor.execute(task);
    } finally {
      this.taskOwners.delete(task.id);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.taskOwners.get(taskId)?.cancelTask?.(taskId);
  }

  async close(): Promise<void> {
    const uniqueExecutors = [...new Set([
      ...this.executors.values(),
      ...(this.monitorExecutor ? [this.monitorExecutor] : [])
    ])];
    await Promise.allSettled(uniqueExecutors.map(async executor => {
      await executor.close?.();
    }));
    this.taskOwners.clear();
  }
}
