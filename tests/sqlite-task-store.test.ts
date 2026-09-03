import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { SqliteTaskStore } from "../src/persistence/sqlite-task-store";
import { Task, TaskState } from "../src/models";

function makeTask(): Task {
  const now = new Date("2026-09-03T07:00:00.000Z");
  return {
    id: "persist-1",
    config: {
      id: "persist-1",
      name: "Persistence Test",
      shopId: "shop-1",
      data: {
        productCriteria: { searchTerm: "pokemon" },
        password: "should-not-persist",
        nested: { apiKey: "should-also-not-persist" }
      }
    },
    state: TaskState.RUNNING,
    createdAt: now,
    updatedAt: now,
    retries: 1,
    maxRetries: 3
  };
}

describe("SqliteTaskStore", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "ares-sqlite-"));
    filePath = path.join(directory, "ares.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists task snapshots and logs across reopen", async () => {
    const task = makeTask();
    const store = await SqliteTaskStore.open(filePath);

    await store.recordTaskEvent(task, {
      taskId: task.id,
      event: "taskStateChanged",
      state: task.state,
      level: "info",
      message: "QUEUED -> RUNNING token=very-secret",
      createdAt: new Date("2026-09-03T07:01:00.000Z")
    });
    await store.close();

    const reopened = await SqliteTaskStore.open(filePath);
    const restored = await reopened.findById(task.id);
    const logs = await reopened.findLogsByTaskId(task.id);

    expect(restored?.state).toBe(TaskState.RUNNING);
    expect(restored?.config.data?.["password"]).toBe("[REDACTED]");
    expect((restored?.config.data?.["nested"] as Record<string, unknown>)?.["apiKey"]).toBe("[REDACTED]");
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain("token=[REDACTED]");
    expect(logs[0].message).not.toContain("very-secret");

    await reopened.close();
  });

  it("returns task logs in chronological order and enforces the requested limit", async () => {
    const task = makeTask();
    const store = await SqliteTaskStore.open(filePath);
    await store.save(task);

    for (let index = 1; index <= 5; index += 1) {
      await store.appendLog({
        taskId: task.id,
        event: `event-${index}`,
        state: task.state,
        level: "info",
        message: `message-${index}`,
        createdAt: new Date(`2026-09-03T07:0${index}:00.000Z`)
      });
    }

    const logs = await store.findLogsByTaskId(task.id, 3);
    expect(logs.map(log => log.event)).toEqual(["event-3", "event-4", "event-5"]);

    await store.close();
  });
});
