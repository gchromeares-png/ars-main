import { ITaskExecutor } from "../src/interfaces";
import { TaskOrchestrator } from "../src/orchestrator";
import { TaskRepositoryMock, WorkerMock } from "../src/mocks";
import { Task, TaskState } from "../src/models";

class ThrowingExecutor implements ITaskExecutor {
  async execute(): Promise<boolean> {
    throw new Error("executor exploded");
  }
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

  complete(taskId: string, success: boolean): void {
    const done = this.completions.get(taskId);
    if (!done) throw new Error(`Task ${taskId} is not running`);
    done(success);
  }
}

describe("task lifecycle safety", () => {
  it("moves executor exceptions out of RUNNING into FAILED", async () => {
    const o = new TaskOrchestrator(new TaskRepositoryMock(), new ThrowingExecutor());
    o.addWorker(new WorkerMock("w1"));
    const task = o.createTask({ id: "throws", name: "throws" });
    task.maxRetries = 0;

    await o.startTask(task.id);

    expect(task.state).toBe(TaskState.FAILED);
    expect(task.lastError).toContain("executor exploded");
    expect(o.getAvailableWorkers()).toBe(1);
  });

  it("does not overlap a resumed run with the still-unwinding paused run", async () => {
    const executor = new DeferredExecutor();
    const o = new TaskOrchestrator(new TaskRepositoryMock(), executor);
    o.addWorker(new WorkerMock("w1"));
    o.addWorker(new WorkerMock("w2"));
    const task = o.createTask({ id: "resume-no-overlap", name: "resume no overlap" });

    const firstRun = o.startTask(task.id);
    await Promise.resolve();
    expect(task.state).toBe(TaskState.RUNNING);
    expect(executor.started).toEqual([task.id]);

    await o.pauseTask(task.id);
    await o.resumeTask(task.id);
    await Promise.resolve();

    expect(task.state).toBe(TaskState.QUEUED);
    expect(executor.started).toEqual([task.id]);
    expect(executor.maxActive).toBe(1);

    executor.complete(task.id, false);
    await firstRun;
    await Promise.resolve();

    expect(executor.started).toEqual([task.id, task.id]);
    expect(executor.maxActive).toBe(1);
    expect(task.state).toBe(TaskState.RUNNING);

    executor.complete(task.id, true);
  });
});
