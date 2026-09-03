import { ITaskExecutor } from "../src/interfaces";
import { TaskOrchestrator } from "../src/orchestrator";
import {
  BrowserManagerMock,
  ProxyManagerMock,
  ShopAdapterMock,
  TaskExecutorMock,
  TaskRepositoryMock,
  WorkerMock
} from "../src/mocks";
import { Task, TaskState } from "../src/models";

function build() {
  return new TaskOrchestrator(
    new TaskRepositoryMock(),
    new TaskExecutorMock(),
    new BrowserManagerMock(),
    new ShopAdapterMock(),
    new ProxyManagerMock()
  );
}

class DeferredExecutor implements ITaskExecutor {
  readonly started: string[] = [];
  readonly cancelled: string[] = [];
  active = 0;
  maxActive = 0;

  private readonly completions = new Map<string, (success: boolean) => void>();

  execute(task: Task): Promise<boolean> {
    this.started.push(task.id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    return new Promise(resolve => {
      this.completions.set(task.id, success => {
        this.completions.delete(task.id);
        this.active -= 1;
        resolve(success);
      });
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.push(taskId);
  }

  complete(taskId: string, success = true): void {
    const complete = this.completions.get(taskId);
    if (!complete) throw new Error(`Task ${taskId} is not running`);
    complete(success);
  }
}

describe("TaskOrchestrator", () => {
  it("creates queued tasks", () => {
    const o = build();
    expect(o.createTask({ id: "1", name: "test" }).state).toBe(TaskState.QUEUED);
  });

  it("runs a task to success", async () => {
    const o = build();
    o.addWorker(new WorkerMock("w1"));
    const task = o.createTask({ id: "2", name: "test" });

    await o.startTask(task.id);

    expect(task.state).toBe(TaskState.SUCCESS);
  });

  it("cancels a queued task", () => {
    const o = build();
    const task = o.createTask({ id: "3", name: "cancel" });

    o.cancelTask(task.id);

    expect(task.state).toBe(TaskState.CANCELLED);
  });

  it("pauses and resumes a queued task", async () => {
    const o = build();
    const task = o.createTask({ id: "pause-queued", name: "pause queued" });

    await o.pauseTask(task.id);
    expect(task.state).toBe(TaskState.PAUSED);

    await o.resumeTask(task.id);
    expect(task.state).toBe(TaskState.QUEUED);
  });

  it("pauses a running task without converting it to failed when execution returns", async () => {
    const executor = new DeferredExecutor();
    const o = new TaskOrchestrator(new TaskRepositoryMock(), executor);
    o.addWorker(new WorkerMock("w1"));
    const task = o.createTask({ id: "pause-running", name: "pause running" });

    const started = o.startTask(task.id);
    await Promise.resolve();
    expect(task.state).toBe(TaskState.RUNNING);

    await o.pauseTask(task.id);
    expect(task.state).toBe(TaskState.PAUSED);
    expect(executor.cancelled).toEqual([task.id]);

    executor.complete(task.id, false);
    await started;

    expect(task.state).toBe(TaskState.PAUSED);
    expect(executor.active).toBe(0);
  });

  it("resumes a paused task back into the worker queue", async () => {
    const executor = new DeferredExecutor();
    const o = new TaskOrchestrator(new TaskRepositoryMock(), executor);
    o.addWorker(new WorkerMock("w1"));
    const task = o.createTask({ id: "resume-running", name: "resume running" });

    const firstRun = o.startTask(task.id);
    await Promise.resolve();
    await o.pauseTask(task.id);
    executor.complete(task.id, false);
    await firstRun;

    await o.resumeTask(task.id);
    await Promise.resolve();

    expect(task.state).toBe(TaskState.RUNNING);
    expect(executor.started).toEqual([task.id, task.id]);

    executor.complete(task.id, true);
  });

  it("restores previously active tasks as paused after initialization", async () => {
    const repository = new TaskRepositoryMock();
    const now = new Date();
    await repository.save({
      id: "restored-running",
      config: { id: "restored-running", name: "restored" },
      state: TaskState.RUNNING,
      createdAt: now,
      updatedAt: now,
      retries: 0,
      maxRetries: 3
    });

    const o = new TaskOrchestrator(repository, new TaskExecutorMock());
    await o.initialize();

    const restored = o.getTask("restored-running");
    expect(restored?.state).toBe(TaskState.PAUSED);
    expect(restored?.lastError).toContain("App-Neustart");
  });

  it("keeps excess tasks queued and starts the next task when a worker is released", async () => {
    const executor = new DeferredExecutor();
    const o = new TaskOrchestrator(new TaskRepositoryMock(), executor);

    o.addWorker(new WorkerMock("w1"));
    o.addWorker(new WorkerMock("w2"));
    o.addWorker(new WorkerMock("w3"));

    const tasks = Array.from({ length: 10 }, (_, index) =>
      o.createTask({ id: `q${index + 1}`, name: `queued-${index + 1}` })
    );

    const starts = tasks.map(task => o.startTask(task.id));
    await Promise.resolve();

    expect(tasks.filter(task => task.state === TaskState.RUNNING)).toHaveLength(3);
    expect(tasks.filter(task => task.state === TaskState.QUEUED)).toHaveLength(7);
    expect(executor.started).toEqual(["q1", "q2", "q3"]);
    expect(executor.maxActive).toBe(3);

    executor.complete("q1");
    await starts[0];
    await Promise.resolve();

    expect(tasks[0].state).toBe(TaskState.SUCCESS);
    expect(tasks[3].state).toBe(TaskState.RUNNING);
    expect(executor.started).toEqual(["q1", "q2", "q3", "q4"]);
    expect(executor.active).toBe(3);
    expect(executor.maxActive).toBe(3);
  });
});
