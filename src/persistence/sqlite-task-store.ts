import { mkdir, readFile, rename, writeFile } from "fs/promises";
import * as path from "path";
import initSqlJs, { Database } from "sql.js";
import { ITaskPersistenceRepository, StoredProductMonitorEvent } from "../interfaces";
import { Task, TaskConfig, TaskLogEntry, TaskLogLevel, TaskState } from "../models";
import type { ProductMonitorEvent, ProductObservation } from "../monitor/models";

const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|password|secret|token)/i;
const SENSITIVE_VALUE = /\b(api[-_]?key|authorization|cookie|password|secret|token)\s*[:=]\s*([^\s,;]+)/gi;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item));
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeValue(nested);
  }
  return result;
}

function sanitizeMessage(message: string): string {
  return message.replace(SENSITIVE_VALUE, (_match, label: string) => `${label}=[REDACTED]`);
}

function serializeConfig(config: TaskConfig): string {
  return JSON.stringify(sanitizeValue(config));
}

function parseConfig(value: unknown): TaskConfig {
  if (typeof value !== "string") throw new Error("Stored task config is invalid.");
  return JSON.parse(value) as TaskConfig;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: asString(row["id"]),
    config: parseConfig(row["config_json"]),
    state: asString(row["state"]) as TaskState,
    createdAt: new Date(asString(row["created_at"])),
    updatedAt: new Date(asString(row["updated_at"])),
    lastError: row["last_error"] == null ? undefined : asString(row["last_error"]),
    retries: asNumber(row["retries"]),
    maxRetries: asNumber(row["max_retries"])
  };
}

function rowToLog(row: Record<string, unknown>): TaskLogEntry {
  return {
    id: asNumber(row["id"]),
    taskId: asString(row["task_id"]),
    event: asString(row["event"]),
    state: row["state"] == null ? undefined : asString(row["state"]) as TaskState,
    level: asString(row["level"]) as TaskLogLevel,
    message: asString(row["message"]),
    createdAt: new Date(asString(row["created_at"]))
  };
}

function serializeMonitorEvent(event: ProductMonitorEvent): string {
  return JSON.stringify(sanitizeValue({
    ...event,
    observedAt: event.observedAt.toISOString(),
    current: {
      ...event.current,
      observedAt: event.current.observedAt.toISOString()
    },
    previous: event.previous
      ? { ...event.previous, observedAt: event.previous.observedAt.toISOString() }
      : undefined
  }));
}

function reviveObservation(input: any): ProductObservation {
  return {
    ...input,
    observedAt: new Date(input.observedAt)
  } as ProductObservation;
}

function rowToMonitorEvent(row: Record<string, unknown>): StoredProductMonitorEvent {
  const parsed = JSON.parse(asString(row["event_json"])) as any;
  return {
    ...parsed,
    id: asNumber(row["id"]),
    taskId: asString(row["task_id"]),
    observedAt: new Date(parsed.observedAt),
    current: reviveObservation(parsed.current),
    previous: parsed.previous ? reviveObservation(parsed.previous) : undefined
  } as StoredProductMonitorEvent;
}

export class SqliteTaskStore implements ITaskPersistenceRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly filePath: string,
    private readonly db: Database
  ) {}

  static async open(filePath: string): Promise<SqliteTaskStore> {
    await mkdir(path.dirname(filePath), { recursive: true });

    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL = await initSqlJs({ locateFile: () => wasmPath });

    let database: Database;
    try {
      const existing = await readFile(filePath);
      database = new SQL.Database(existing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && code !== "ENOENT") throw error;
      database = new SQL.Database();
    }

    const store = new SqliteTaskStore(filePath, database);
    store.migrate();
    await store.persist();
    return store;
  }

  async save(task: Task): Promise<void> {
    await this.mutate(() => this.upsertTask(task));
  }

  async update(task: Task): Promise<void> {
    await this.save(task);
  }

  async findById(id: string): Promise<Task | null> {
    await this.writeQueue;
    const statement = this.db.prepare(`
      SELECT id, config_json, state, created_at, updated_at, last_error, retries, max_retries
      FROM tasks WHERE id = ? LIMIT 1
    `, [id]);

    try {
      return statement.step() ? rowToTask(statement.getAsObject()) : null;
    } finally {
      statement.free();
    }
  }

  async findAll(): Promise<Task[]> {
    await this.writeQueue;
    const statement = this.db.prepare(`
      SELECT id, config_json, state, created_at, updated_at, last_error, retries, max_retries
      FROM tasks ORDER BY updated_at DESC
    `);

    const tasks: Task[] = [];
    try {
      while (statement.step()) tasks.push(rowToTask(statement.getAsObject()));
    } finally {
      statement.free();
    }
    return tasks;
  }

  async delete(id: string): Promise<void> {
    await this.mutate(() => {
      this.db.run("BEGIN TRANSACTION");
      try {
        this.db.run("DELETE FROM task_logs WHERE task_id = ?", [id]);
        this.db.run("DELETE FROM product_monitor_events WHERE task_id = ?", [id]);
        this.db.run("DELETE FROM tasks WHERE id = ?", [id]);
        this.db.run("COMMIT");
      } catch (error) {
        this.db.run("ROLLBACK");
        throw error;
      }
    });
  }

  async appendLog(entry: TaskLogEntry): Promise<void> {
    await this.mutate(() => this.insertLog(entry));
  }

  async findLogsByTaskId(taskId: string, limit = 100): Promise<TaskLogEntry[]> {
    await this.writeQueue;
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const statement = this.db.prepare(`
      SELECT id, task_id, event, state, level, message, created_at
      FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?
    `, [taskId, safeLimit]);

    const logs: TaskLogEntry[] = [];
    try {
      while (statement.step()) logs.push(rowToLog(statement.getAsObject()));
    } finally {
      statement.free();
    }
    return logs.reverse();
  }

  async deleteLogsByTaskId(taskId: string): Promise<void> {
    await this.mutate(() => this.db.run("DELETE FROM task_logs WHERE task_id = ?", [taskId]));
  }

  async recordProductMonitorEvent(taskId: string, event: ProductMonitorEvent): Promise<void> {
    await this.mutate(() => {
      this.db.run(`
        INSERT INTO product_monitor_events (task_id, product_key, change_type, event_json, observed_at)
        VALUES (?, ?, ?, ?, ?)
      `, [taskId, event.key, event.type, serializeMonitorEvent(event), event.observedAt.toISOString()]);
    });
  }

  async findProductMonitorEventsByTaskId(taskId: string, limit = 100): Promise<StoredProductMonitorEvent[]> {
    await this.writeQueue;
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const statement = this.db.prepare(`
      SELECT id, task_id, event_json
      FROM product_monitor_events
      WHERE task_id = ?
      ORDER BY id DESC
      LIMIT ?
    `, [taskId, safeLimit]);

    const events: StoredProductMonitorEvent[] = [];
    try {
      while (statement.step()) events.push(rowToMonitorEvent(statement.getAsObject()));
    } finally {
      statement.free();
    }
    return events.reverse();
  }

  async deleteProductMonitorEventsByTaskId(taskId: string): Promise<void> {
    await this.mutate(() => this.db.run("DELETE FROM product_monitor_events WHERE task_id = ?", [taskId]));
  }

  async recordTaskEvent(task: Task, entry: TaskLogEntry): Promise<void> {
    await this.mutate(() => {
      this.db.run("BEGIN TRANSACTION");
      try {
        this.upsertTask(task);
        this.insertLog(entry);
        this.db.run("COMMIT");
      } catch (error) {
        this.db.run("ROLLBACK");
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.writeQueue;
    await this.persist();
    this.db.close();
  }

  private migrate(): void {
    this.db.run(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3
      );

      CREATE TABLE IF NOT EXISTS task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event TEXT NOT NULL,
        state TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS product_monitor_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        product_key TEXT NOT NULL,
        change_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_logs_task_id_id
        ON task_logs(task_id, id);

      CREATE INDEX IF NOT EXISTS idx_product_monitor_events_task_id_id
        ON product_monitor_events(task_id, id);
    `);
  }

  private upsertTask(task: Task): void {
    this.db.run(`
      INSERT INTO tasks (
        id, config_json, state, created_at, updated_at, last_error, retries, max_retries
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        config_json = excluded.config_json,
        state = excluded.state,
        updated_at = excluded.updated_at,
        last_error = excluded.last_error,
        retries = excluded.retries,
        max_retries = excluded.max_retries
    `, [
      task.id,
      serializeConfig(task.config),
      task.state,
      task.createdAt.toISOString(),
      task.updatedAt.toISOString(),
      task.lastError ? sanitizeMessage(task.lastError) : null,
      task.retries,
      task.maxRetries
    ]);
  }

  private insertLog(entry: TaskLogEntry): void {
    this.db.run(`
      INSERT INTO task_logs (task_id, event, state, level, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      entry.taskId,
      entry.event,
      entry.state ?? null,
      entry.level,
      sanitizeMessage(entry.message),
      entry.createdAt.toISOString()
    ]);
  }

  private async mutate(operation: () => void): Promise<void> {
    const run = this.writeQueue.then(async () => {
      operation();
      await this.persist();
    });

    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private async persist(): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, Buffer.from(this.db.export()));
    await rename(tempPath, this.filePath);
  }
}
