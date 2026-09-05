import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import Database from "better-sqlite3";
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

  it("serializes concurrent callers through the single native connection without losing writes", async () => {
    const task = makeTask();
    const store = await SqliteTaskStore.open(filePath);
    await store.save(task);

    await Promise.all(Array.from({ length: 20 }, (_value, index) => store.appendLog({
      taskId: task.id,
      event: `parallel-${index}`,
      state: task.state,
      level: "info",
      message: `parallel-message-${index}`,
      createdAt: new Date(1_800_000_000_000 + index)
    })));

    const logs = await store.findLogsByTaskId(task.id, 100);
    expect(logs).toHaveLength(20);
    expect(new Set(logs.map(log => log.event)).size).toBe(20);
    await store.close();
  });

  it("upgrades an existing pre-migration SQLite file in place and keeps its data", async () => {
    const task = makeTask();
    const legacy = new Database(filePath);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3
      );
    `);
    legacy.prepare(`
      INSERT INTO tasks (id, config_json, state, created_at, updated_at, last_error, retries, max_retries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      JSON.stringify(task.config),
      task.state,
      task.createdAt.toISOString(),
      task.updatedAt.toISOString(),
      null,
      task.retries,
      task.maxRetries
    );
    legacy.close();

    const store = await SqliteTaskStore.open(filePath);
    const restored = await store.findById(task.id);
    expect(restored?.id).toBe(task.id);
    expect(restored?.state).toBe(task.state);
    await store.close();

    const inspector = new Database(filePath, { readonly: true, fileMustExist: true });
    const migration = inspector.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations"
    ).get() as Record<string, unknown>;
    expect(Number(migration["version"])).toBe(1);
    expect(String(inspector.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    expect(String(inspector.pragma("quick_check", { simple: true })).toLowerCase()).toBe("ok");
    inspector.close();
  });

  it("fails loudly on an existing corrupt database and never replaces its bytes", async () => {
    await writeFile(filePath, Buffer.from("ARES-corrupt-database-do-not-replace", "utf8"));
    const before = await readFile(filePath);

    await expect(SqliteTaskStore.open(filePath)).rejects.toThrow("ARES SQLite konnte nicht sicher geöffnet werden");

    const after = await readFile(filePath);
    expect(after.equals(before)).toBe(true);
  });
});
