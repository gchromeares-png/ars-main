import { CancellationManager } from "../src/cancellation-manager";
import { EventBus } from "../src/event-bus";
import {
  BrowserManagerMock,
  ProxyManagerMock,
  ShopAdapterMock
} from "../src/mocks";
import { TaskState } from "../src/models";
import { TaskExecutor } from "../src/task-executor";

describe("TaskExecutor", () => {
  it("executes the mocked flow", async () => {
    const executor = new TaskExecutor(
      new EventBus(),
      new CancellationManager(),
      new BrowserManagerMock(),
      new ShopAdapterMock(),
      new ProxyManagerMock()
    );

    const result = await executor.execute({
      id: "1",
      config: { id: "1", name: "test" },
      state: TaskState.RUNNING,
      createdAt: new Date(),
      updatedAt: new Date(),
      retries: 0,
      maxRetries: 3
    });

    expect(result).toBe(true);
  });
});