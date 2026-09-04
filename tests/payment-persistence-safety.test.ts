import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import initSqlJs from "sql.js";
import { SqliteTaskStore } from "../src/persistence/sqlite-task-store";
import { TaskState } from "../src/models";

describe("payment persistence safety", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "ares-payment-persistence-"));
    filePath = path.join(directory, "ares.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("never persists runtime payment session secrets on normal task writes", async () => {
    const pan = Array.from({ length: 16 }, () => "4").join("");
    const cvc = ["1", "2", "3"].join("");
    const now = new Date("2026-09-04T08:00:00.000Z");
    const store = await SqliteTaskStore.open(filePath);

    await store.save({
      id: "payment-safe-write",
      config: {
        id: "payment-safe-write",
        name: "Payment Safe Write",
        shopId: "shop-1",
        data: {
          profileId: "profile-1",
          __paymentSession: {
            method: "card",
            card: {
              cardholderName: "Should Never Persist",
              cardNumber: pan,
              expiry: "12/30",
              cvc
            }
          }
        }
      },
      state: TaskState.RUNNING,
      createdAt: now,
      updatedAt: now,
      retries: 0,
      maxRetries: 0
    });
    await store.close();

    const reopened = await SqliteTaskStore.open(filePath);
    const restored = await reopened.findById("payment-safe-write");
    expect(restored?.config.data).not.toHaveProperty("__paymentSession");
    await reopened.close();

    const bytes = await readFile(filePath);
    const SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
    const db = new SQL.Database(bytes);
    const statement = db.prepare("SELECT config_json FROM tasks WHERE id = ?", ["payment-safe-write"]);
    expect(statement.step()).toBe(true);
    const raw = String(statement.getAsObject()["config_json"] ?? "");
    statement.free();
    db.close();

    expect(raw).not.toContain("__paymentSession");
    expect(raw).not.toContain(pan);
    expect(raw).not.toContain(cvc);
    expect(raw).not.toMatch(/cardNumber|\"cvc\"|cvv|securityCode/i);
  });

  it("scrubs legacy plaintext payment values when an existing database is reopened", async () => {
    const pan = Array.from({ length: 16 }, () => "5").join("");
    const cvc = ["9", "8", "7"].join("");
    const SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
    const legacyDb = new SQL.Database();

    legacyDb.run(`
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
      CREATE TABLE task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event TEXT NOT NULL,
        state TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE product_monitor_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        product_key TEXT NOT NULL,
        change_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);

    const legacyConfig = JSON.stringify({
      id: "legacy-payment",
      name: "Legacy Payment",
      shopId: "shop-1",
      data: {
        profileId: "profile-legacy",
        __paymentSession: {
          method: "card",
          card: {
            holderName: "Legacy Holder",
            cardNumber: pan,
            expiry: "12/30",
            securityCode: cvc
          }
        },
        leakedCardNumber: pan,
        cardNumber: pan,
        cvc,
        cvv: cvc,
        securityCode: cvc
      }
    });
    const now = "2026-09-04T08:00:00.000Z";
    legacyDb.run(
      "INSERT INTO tasks (id, config_json, state, created_at, updated_at, last_error, retries, max_retries) VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
      ["legacy-payment", legacyConfig, TaskState.RUNNING, now, now, `cardNumber=${pan} cvc=${cvc}`]
    );
    legacyDb.run(
      "INSERT INTO task_logs (task_id, event, state, level, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["legacy-payment", "legacy", TaskState.RUNNING, "error", `securityCode=${cvc} cardNumber=${pan}`, now]
    );
    legacyDb.run(
      "INSERT INTO product_monitor_events (task_id, product_key, change_type, event_json, observed_at) VALUES (?, ?, ?, ?, ?)",
      ["legacy-payment", "product", "update", JSON.stringify({ product: "x", cvc, cardNumber: pan }), now]
    );

    await writeFile(filePath, Buffer.from(legacyDb.export()));
    legacyDb.close();

    const store = await SqliteTaskStore.open(filePath);
    const restored = await store.findById("legacy-payment");
    const logs = await store.findLogsByTaskId("legacy-payment");
    expect(restored?.config.data).not.toHaveProperty("__paymentSession");
    expect(restored?.config.data).not.toHaveProperty("cardNumber");
    expect(restored?.config.data).not.toHaveProperty("cvc");
    expect(restored?.config.data).not.toHaveProperty("cvv");
    expect(restored?.config.data).not.toHaveProperty("securityCode");
    expect(logs[0]?.message).not.toContain(pan);
    expect(logs[0]?.message).not.toContain(cvc);
    await store.close();

    const reopenedDb = new SQL.Database(await readFile(filePath));
    const tables = [
      ["tasks", "config_json"],
      ["tasks", "last_error"],
      ["task_logs", "message"],
      ["product_monitor_events", "event_json"]
    ] as const;
    const rawParts: string[] = [];
    for (const [table, column] of tables) {
      const statement = reopenedDb.prepare(`SELECT ${column} FROM ${table}`);
      while (statement.step()) rawParts.push(String(statement.getAsObject()[column] ?? ""));
      statement.free();
    }
    reopenedDb.close();
    const raw = rawParts.join("\n");

    expect(raw).not.toContain("__paymentSession");
    expect(raw).not.toContain(pan);
    expect(raw).not.toContain(cvc);
  });
});
