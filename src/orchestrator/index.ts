import {
  ITaskExecutor,
  ITaskRepository,
  IBrowserManager,
  IShopAdapter,
  IProxyManager,
  IWorker,
  TaskEvents
} from "../interfaces";
import { CancellationManager } from "../cancellation-manager";
import { EventBus } from "../event-bus";
import { RetryScheduler } from "../retry-scheduler";
import { StateMachine } from "../state-machine";
import { TaskRegistry } from "../task-registry";
import { Task, TaskConfig, TaskState } from "../models";
import { TaskExecutor } from "../task-executor";
import { WorkerPool } from "../worker-pool";

export class TaskOrchestrator {
  private readonly eventBus = new EventBus();
  private readonly stateMachine = new StateMachine();
  private readonly retryScheduler = new RetryScheduler(this.eventBus);
  private readonly cancellationManager = new CancellationManager();
  private readonly workerPool = new WorkerPool(this.eventBus);
  private readonly registry: TaskRegistry;
  private readonly executor: ITaskExecutor;
  private readonly pendingTaskIds: string[] = [];
  private readonly pendingTaskIdSet = new Set<string>();

  constructor(
    repository: ITaskRepository,
    executor: ITaskExecutor,
    browserManager?: IBrowserManager,
    shopAdapter?: IShopAdapter,
    proxyManager?: IProxyManager
  ) {
    this.registry = new TaskRegistry(repository);

    this.executor =
      browserManager && shopAdapter && proxyManager
        ? new TaskExecutor(
            this.eventBus,
            this.cancellationManager,
            browserManager,
            shopAdapter,
            proxyManager
          )
        : executor;

    this.eventBus.on("taskFailed", task => {
      if (task.retries < task.maxRetries) {
        task.retries += 1;
        this.transition(task, TaskState.RETRYING);
        this.retryScheduler.scheduleRetry(task);
      }
    });

    this.eventBus.on("taskRetrying", task => {
      if (task.state === TaskState.RETRYING) {
        this.transition(task, TaskState.QUEUED);
        void this.startTask(task.id);
      }
    });
  }

  createTask(config: TaskConfig): Task {
    const task = this.registry.createTask(config);
    this.transition(task, TaskState.QUEUED);
    return task;
  }

  async startTask(taskId: string): Promise<void> {
    const task = this.registry.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.state !== TaskState.QUEUED) {
      throw new Error(`Task ${taskId} cannot start from ${task.state}`);
    }

    const workerId = this.workerPool.assignTask(task);
    if (!workerId) {
      this.enqueueTask(taskId);
      return;
    }

    this.removePendingTask(taskId);

    try {
      this.transition(task, TaskState.STARTING);
      this.transition(task, TaskState.RUNNING);
      this.eventBus.emit("taskStarted", task);

      const success = await this.executor.execute(task);

      const currentState = task.state as TaskState;
      if (currentState === TaskState.CANCELLED || currentState === TaskState.PAUSED) {
        await this.registry.saveTask(task.id);
        return;
      }

      if (success) {
        this.transition(task, TaskState.CHECKOUT);
        this.transition(task, TaskState.SUCCESS);
      } else {
        this.transition(task, TaskState.FAILED);
        this.eventBus.emit("taskFailed", task);
      }

      await this.registry.saveTask(task.id);
    } finally {
      this.workerPool.releaseWorker(workerId);
      this.drainQueue();
    }
  }

  async pauseTask(taskId: string): Promise<void> {
    const task = this.registry.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    this.removePendingTask(taskId);
    this.retryScheduler.cancelRetry(taskId);

    if (!this.stateMachine.canTransition(task.state, TaskState.PAUSED)) {
      throw new Error(`Task ${taskId} cannot pause from ${task.state}`);
    }

    this.transition(task, TaskState.PAUSED);
    this.cancellationManager.cancelTask(taskId);
    void this.executor.cancelTask?.(taskId).catch(error => {
      task.lastError = error instanceof Error ? error.message : String(error);
    });

    await this.registry.saveTask(task.id);
    this.drainQueue();
  }

  async resumeTask(taskId: string): Promise<void> {
    const task = this.registry.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.state !== TaskState.PAUSED) {
      throw new Error(`Task ${taskId} cannot resume from ${task.state}`);
    }

    this.transition(task, TaskState.QUEUED);
    this.eventBus.emit("taskResumed", task);
    await this.registry.saveTask(task.id);
    this.drainQueue();
  }

  cancelTask(taskId: string): void {
    const task = this.registry.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    this.removePendingTask(taskId);
    this.retryScheduler.cancelRetry(taskId);
    this.cancellationManager.cancelTask(taskId);
    void this.executor.cancelTask?.(taskId).catch(error => {
      task.lastError = error instanceof Error ? error.message : String(error);
    });

    if (this.stateMachine.canTransition(task.state, TaskState.CANCELLED)) {
      this.transition(task, TaskState.CANCELLED);
      this.eventBus.emit("taskCancelled", task);
    }
  }

  addWorker(worker: IWorker): void {
    this.workerPool.addWorker(worker);
    this.drainQueue();
  }

  getAvailableWorkers(): number {
    return this.workerPool.getAvailableWorkers();
  }

  getTask(id: string): Task | undefined {
    return this.registry.getTask(id);
  }

  getAllTasks(): Task[] {
    return this.registry.getAllTasks();
  }

  on<T extends keyof TaskEvents>(
    event: T,
    callback: (data: TaskEvents[T]) => void
  ): () => void {
    return this.eventBus.on(event, callback);
  }

  cleanup(): void {
    this.pendingTaskIds.length = 0;
    this.pendingTaskIdSet.clear();
    this.retryScheduler.cleanup();
    this.cancellationManager.cleanup();
    for (const worker of this.workerPool.getAllWorkers()) worker.stop();
  }

  private enqueueTask(taskId: string): void {
    if (this.pendingTaskIdSet.has(taskId)) return;
    this.pendingTaskIdSet.add(taskId);
    this.pendingTaskIds.push(taskId);
  }

  private removePendingTask(taskId: string): void {
    if (!this.pendingTaskIdSet.delete(taskId)) return;

    const index = this.pendingTaskIds.indexOf(taskId);
    if (index >= 0) this.pendingTaskIds.splice(index, 1);
  }

  private drainQueue(): void {
    while (this.workerPool.getAvailableWorkers() > 0 && this.pendingTaskIds.length > 0) {
      const taskId = this.pendingTaskIds.shift();
      if (!taskId) return;

      this.pendingTaskIdSet.delete(taskId);
      const task = this.registry.getTask(taskId);
      if (!task || task.state !== TaskState.QUEUED) continue;

      void this.startTask(taskId).catch(error => {
        task.lastError = error instanceof Error ? error.message : String(error);
      });
    }
  }

  private transition(task: Task, newState: TaskState): void {
    if (!this.stateMachine.canTransition(task.state, newState)) {
      throw new Error(`Invalid transition: ${task.state} -> ${newState}`);
    }

    task.state = newState;
    task.updatedAt = new Date();

    const event =
      newState === TaskState.QUEUED ? "taskQueued" :
      newState === TaskState.SUCCESS ? "taskCompleted" :
      newState === TaskState.CANCELLED ? "taskCancelled" :
      newState === TaskState.PAUSED ? "taskPaused" :
      "taskUpdated";

    this.eventBus.emit(event, task);
  }
}
