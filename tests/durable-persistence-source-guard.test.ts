import * as fs from "fs";
import * as path from "path";

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

describe("ARES durable SQLite persistence architecture", () => {
  const packageJson = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
  const store = read("src/persistence/sqlite-task-store.ts");
  const scrubber = read("src/persistence/sensitive-data-scrubber.ts");

  it("uses pinned native better-sqlite3 persistence", () => {
    expect(packageJson.dependencies["better-sqlite3"]).toBe("9.6.0");
    expect(store).toContain('from "better-sqlite3"');
    expect(scrubber).toContain('from "better-sqlite3"');
    expect(store).not.toContain("db.export");
    expect(store).not.toContain(".tmp");
    expect(store).not.toContain("rename(");
  });

  it("configures every native connection before the store becomes available", () => {
    expect(store).toContain('db.pragma("journal_mode = WAL", { simple: true })');
    expect(store).toContain('db.pragma("synchronous = FULL")');
    expect(store).toContain('db.pragma("foreign_keys = ON")');
    expect(store).toContain("busy_timeout = ${BUSY_TIMEOUT_MS}");
    expect(store).toContain('db.pragma("quick_check", { simple: true })');
  });

  it("fails existing corruption instead of silently replacing the database", () => {
    expect(store).toContain("const existed = fs.existsSync(filePath)");
    expect(store).toContain("fileMustExist: true");
    expect(store).toContain("if (existed) SqliteTaskStore.assertIntegrity(database)");
    expect(store).not.toContain('code !== "ENOENT"');
  });

  it("uses native SQLite transactions and explicit schema versioning", () => {
    expect(store).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
    expect(store).toContain("this.db.transaction(");
    expect(store).toContain("CURRENT_SCHEMA_VERSION");
    expect(store).not.toContain('run("BEGIN TRANSACTION")');
  });

  it("keeps Electron ABI preparation explicit rather than mutating Node CI on postinstall", () => {
    expect(packageJson.scripts["native:electron"]).toBe("electron-builder install-app-deps");
    expect(packageJson.scripts["electron"]).toContain("npm run native:electron");
    expect(packageJson.scripts["postinstall"]).toBeUndefined();
  });
});
