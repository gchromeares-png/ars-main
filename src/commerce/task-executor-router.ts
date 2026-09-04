import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import { isCommerceMonitorTask } from "../monitor/commerce-monitor-service";
import { isEarlyGateChildTask } from "../monitor/early-gate";
import type { CommercePlatform, CommerceShop } from "./platforms";

type RuntimeUpdateSource = ITaskExecutor & {
  onTaskUpdate?: (callback: (task: Task) => void) => () => void;
};

export class CommerceTaskExecutorRouter implements ITaskExecutor {
  private readonly executors = new Map<CommercePlatform, ITaskExecutor>();
  private readonly taskOwners = new Map<string, ITaskExecutor>();
  private readonly runtimeListeners = new Set<(task: Task) => void>();
  private readonly runtimeUnsubscribers = new Map<ITaskExecutor, () => void>();
  private monitorExecutor?: ITaskExecutor;
  private earlyGateExecutor?: ITaskExecutor;

  constructor(private readonly getShop: (shopId: string) => CommerceShop | undefined) {}

  register(platform: CommercePlatform, executor: ITaskExecutor): void {
    this.executors.set(platform, executor);
    this.attachRuntimeUpdates(executor);
  }

  registerMonitorExecutor(executor: ITaskExecutor): void {
    this.monitorExecutor = executor;
    this.attachRuntimeUpdates(executor);
  }

  registerEarlyGateExecutor(executor: ITaskExecutor): void {
    this.earlyGateExecutor = executor;
    this.attachRuntimeUpdates(executor);
  }

  hasExecutor(platform: CommercePlatform): boolean {
    return this.executors.has(platform);
  }

  hasMonitorExecutor(): boolean {
    return Boolean(this.monitorExecutor);
  }

  hasEarlyGateExecutor(): boolean {
    return Boolean(this.earlyGateExecutor);
  }

  listExecutorPlatforms(): CommercePlatform[] {
    return [...this.executors.keys()];
  }

  onTaskUpdate(callback: (task: Task) => void): () => void {
    this.runtimeListeners.add(callback);
    return () => this.runtimeListeners.delete(callback);
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

    const monitorTask = isCommerceMonitorTask(task);
    const earlyGateChild = isEarlyGateChildTask(task);
    const executor = monitorTask
      ? this.monitorExecutor
      : earlyGateChild
        ? this.earlyGateExecutor
        : this.executors.get(shop.platform);

    if (!executor) {
      task.lastError = monitorTask
        ? "Für Monitoring ist noch kein CommerceMonitorService registriert."
        : earlyGateChild
          ? "Für Early-Gate-Browser-Children ist noch kein Browser-Executor registriert."
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

  async updateDiscoveryKeywords(taskId: string, keywords: string[]): Promise<string[]> {
    const owner = this.taskOwners.get(taskId);
    if (!owner) throw new Error(`Laufender Browser-Child ${taskId} wurde nicht gefunden.`);
    if (!owner.updateDiscoveryKeywords) {
      throw new Error(`Task ${taskId} unterstützt keine Live-Discovery-Keywords.`);
    }
    return owner.updateDiscoveryKeywords(taskId, keywords);
  }

  async setFinalPurchaseAllowed(allowed: boolean): Promise<void> {
    const uniqueExecutors = this.uniqueExecutors();
    await Promise.all(uniqueExecutors.map(async executor => {
      await executor.setFinalPurchaseAllowed?.(allowed === true);
    }));
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.taskOwners.get(taskId)?.cancelTask?.(taskId);
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.runtimeUnsubscribers.values()) unsubscribe();
    this.runtimeUnsubscribers.clear();
    this.runtimeListeners.clear();

    await Promise.allSettled(this.uniqueExecutors().map(async executor => {
      await executor.close?.();
    }));
    this.taskOwners.clear();
  }

  private uniqueExecutors(): ITaskExecutor[] {
    return [...new Set([
      ...this.executors.values(),
      ...(this.monitorExecutor ? [this.monitorExecutor] : []),
      ...(this.earlyGateExecutor ? [this.earlyGateExecutor] : [])
    ])];
  }

  private attachRuntimeUpdates(executor: ITaskExecutor): void {
    const runtimeSource = executor as RuntimeUpdateSource;
    if (!runtimeSource.onTaskUpdate || this.runtimeUnsubscribers.has(executor)) return;
    const unsubscribe = runtimeSource.onTaskUpdate(task => {
      for (const listener of this.runtimeListeners) listener(task);
    });
    this.runtimeUnsubscribers.set(executor, unsubscribe);
  }
}
