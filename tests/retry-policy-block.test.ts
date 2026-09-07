import type { ITaskExecutor } from "../src/interfaces";
import { TaskOrchestrator } from "../src/orchestrator";
import { TaskRepositoryMock, WorkerMock } from "../src/mocks";
import type { Task } from "../src/models";
import { TaskState } from "../src/models";

class RetryBlockedExecutor implements ITaskExecutor {
  calls = 0;

  async execute(task: Task): Promise<boolean> {
    this.calls += 1;
    task.config.data = {
      ...(task.config.data ?? {}),
      retryPolicy: {
        blocked: true,
        reason: "ambiguous-final-submit",
        attempts: 2,
        maxAttempts: 2
      }
    };
    return false;
  }
}

describe("retryPolicy.blocked", () => {
  it("prevents the outer task retry after the recovery budget is exhausted", async () => {
    const executor = new RetryBlockedExecutor();
    const orchestrator = new TaskOrchestrator(new TaskRepositoryMock(), executor);
    orchestrator.addWorker(new WorkerMock("retry-policy-worker"));
    const task = orchestrator.createTask({
      id: "retry-policy-blocked",
      name: "retry policy blocked",
      maxRetries: 5
    });

    await orchestrator.startTask(task.id);

    expect(executor.calls).toBe(1);
    expect(task.state).toBe(TaskState.FAILED);
    expect(task.retries).toBe(0);
    expect((task.config.data?.["retryPolicy"] as any)?.blocked).toBe(true);
    orchestrator.cleanup();
  });
});
