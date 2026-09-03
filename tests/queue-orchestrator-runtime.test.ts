import type { ITaskExecutor, ITaskRepository } from "../src/interfaces";
import { WorkerMock } from "../src/mocks";
import { Task, TaskState } from "../src/models";
import { TaskOrchestrator } from "../src/orchestrator";

class MemoryTaskRepository implements ITaskRepository {
  private readonly items = new Map<string, Task>();

  async save(task: Task): Promise<void> {
    this.items.set(task.id, task);
  }

  async findById(id: string): Promise<Task | null> {
    return this.items.get(id) ?? null;
  }

  async findAll(): Promise<Task[]> {
    return [...this.items.values()];
  }

  async update(task: Task): Promise<void> {
    this.items.set(task.id, task);
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

class RuntimeUpdateExecutor implements ITaskExecutor {
  private readonly listeners = new Set<(task: Task) => void>();
  private task?: Task;
  private finish?: (value: boolean) => void;
  private startResolve!: () => void;
  readonly started = new Promise<void>(resolve => { this.startResolve = resolve; });

  async execute(task: Task): Promise<boolean> {
    this.task = task;
    this.startResolve();
    return new Promise<boolean>(resolve => { this.finish = resolve; });
  }

  onTaskUpdate(listener: (task: Task) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setQueue(active: boolean): void {
    if (!this.task) throw new Error("Task has not started yet.");
    this.task.config.data = {
      ...(this.task.config.data ?? {}),
      queueStatus: {
        active,
        phase: active ? "waiting" : "released",
        source: "dom",
        detectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedMs: 100,
        maxWaitMs: 60 * 60_000
      }
    };
    for (const listener of this.listeners) listener(this.task);
  }

  complete(success = true): void {
    this.finish?.(success);
  }
}

describe("TaskOrchestrator queue runtime updates", () => {
  it("moves RUNNING -> WAITING_QUEUE -> RUNNING and still completes normally", async () => {
    const repository = new MemoryTaskRepository();
    const executor = new RuntimeUpdateExecutor();
    const orchestrator = new TaskOrchestrator(repository, executor);
    orchestrator.addWorker(new WorkerMock("queue-worker-slot"));

    const task = orchestrator.createTask({
      id: "queue-runtime-task",
      name: "Queue Runtime Task",
      shopId: "shop",
      maxRetries: 0,
      data: {}
    });

    const run = orchestrator.startTask(task.id);
    await executor.started;
    expect(orchestrator.getTask(task.id)?.state).toBe(TaskState.RUNNING);

    executor.setQueue(true);
    expect(orchestrator.getTask(task.id)?.state).toBe(TaskState.WAITING_QUEUE);

    executor.setQueue(false);
    expect(orchestrator.getTask(task.id)?.state).toBe(TaskState.RUNNING);

    executor.complete(true);
    await run;
    expect(orchestrator.getTask(task.id)?.state).toBe(TaskState.SUCCESS);

    orchestrator.cleanup();
  });

  it("allows a waiting queue task to be paused", async () => {
    const repository = new MemoryTaskRepository();
    const executor = new RuntimeUpdateExecutor();
    const orchestrator = new TaskOrchestrator(repository, executor);
    orchestrator.addWorker(new WorkerMock("queue-pause-slot"));

    const task = orchestrator.createTask({
      id: "queue-pause-task",
      name: "Queue Pause Task",
      shopId: "shop",
      maxRetries: 0,
      data: {}
    });

    const run = orchestrator.startTask(task.id);
    await executor.started;
    executor.setQueue(true);
    expect(orchestrator.getTask(task.id)?.state).toBe(TaskState.WAITING_QUEUE);

    await orchestrator.pauseTask(task.id);
    expect(orchestrator.getTask(task.id)?.state).toBe(TaskState.PAUSED);

    executor.complete(false);
    await run;
    expect(orchestrator.getTask(task.id)?.state).toBe(TaskState.PAUSED);

    orchestrator.cleanup();
  });
});
