import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TaskOrchestrator } from "../orchestrator";
import { WorkerMock } from "../mocks";
import { BrowserWorkerPoolClient } from "../browser-worker/client";
import { TaskConfig } from "../models";
import { ProfileRepository } from "../profiles/profile-repository";
import { AresProfile } from "../profiles/models";
import { SqliteTaskStore } from "../persistence/sqlite-task-store";
import { TaskPersistenceCoordinator } from "../persistence/task-persistence-coordinator";

let mainWindow: BrowserWindow | null = null;
let orchestrator: TaskOrchestrator;
let browserWorker: BrowserWorkerPoolClient;
let taskStore: SqliteTaskStore;
let persistenceCoordinator: TaskPersistenceCoordinator;
let quitting = false;

interface SystemNodeStatus {
  executable: string;
  version?: string;
  major?: number;
  ok: boolean;
  error?: string;
}

function broadcastTaskUpdate(task: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("task-status-update", task);
    }
  }
}

const shops = new Map<string, {
  id: string;
  name: string;
  baseUrl: string;
  platform: "shopify";
  config: Record<string, unknown>;
}>();
const profileRepository = new ProfileRepository();

function getShopsFilePath(): string | undefined {
  try {
    const userData = app?.getPath ? app.getPath("userData") : undefined;
    return userData ? path.join(userData, "shops.json") : undefined;
  } catch {
    return undefined;
  }
}

function persistShops(): void {
  const filePath = getShopsFilePath();
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify([...shops.values()], null, 2), "utf8");
  } catch {}
}

function loadShops(): void {
  const filePath = getShopsFilePath();
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      const items = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item?.id) shops.set(item.id, item);
        }
      }
    }
  } catch {}
}

function parseNodeMajor(versionText: string): number | undefined {
  const match = versionText.trim().match(/^v?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function readSystemNodeStatus(): SystemNodeStatus {
  const executable = process.env["ARES_NODE_EXECUTABLE"]?.trim() || "node";

  try {
    const version = execFileSync(executable, ["-v"], {
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true
    }).trim();
    const major = parseNodeMajor(version);

    return {
      executable,
      version,
      major,
      ok: typeof major === "number" && major >= 20,
      error: typeof major === "number" && major >= 20
        ? undefined
        : `System Node muss mindestens v20 sein, aktuell: ${version || "unbekannt"}.`
    };
  } catch (error) {
    return {
      executable,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function createBackend(): Promise<void> {
  const userData = app.getPath("userData");
  profileRepository.setStoragePath(path.join(userData, "profiles.json"));
  loadShops();

  browserWorker = new BrowserWorkerPoolClient(
    shopId => shops.get(shopId),
    profileId => profileRepository.get(profileId),
    { profileRoot: path.join(userData, "browser-profiles") }
  );

  taskStore = await SqliteTaskStore.open(path.join(userData, "ares.sqlite"));
  orchestrator = new TaskOrchestrator(taskStore, browserWorker);
  persistenceCoordinator = new TaskPersistenceCoordinator(orchestrator, taskStore);
  await orchestrator.initialize();

  const configuredConcurrency = Number(process.env["ARES_MAX_CONCURRENT_TASKS"] ?? "4");
  const maxConcurrentTasks = Number.isFinite(configuredConcurrency)
    ? Math.min(16, Math.max(1, Math.floor(configuredConcurrency)))
    : 4;
  for (let index = 1; index <= maxConcurrentTasks; index++) {
    orchestrator.addWorker(new WorkerMock(`browser-slot-${index}`));
  }

  const forwardTask = (task: unknown) => {
    mainWindow?.webContents.send("task-status-update", task);
  };

  orchestrator.on("taskCreated", forwardTask);
  orchestrator.on("taskQueued", forwardTask);
  orchestrator.on("taskStarted", forwardTask);
  orchestrator.on("taskUpdated", forwardTask);
  orchestrator.on("taskPaused", forwardTask);
  orchestrator.on("taskResumed", forwardTask);
  orchestrator.on("taskCompleted", forwardTask);
  orchestrator.on("taskFailed", forwardTask);
  orchestrator.on("taskCancelled", forwardTask);
  orchestrator.on("taskRetrying", forwardTask);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devServerUrl = process.env["ARES_UI_URL"];
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../../ares/index.html"));
  }

  return win;
}

ipcMain.handle("get-profiles", () => ({
  success: true,
  profiles: profileRepository.getAll()
}));

ipcMain.handle("save-profile", (_event, profile: AresProfile) => {
  if (!profile?.id || !profile?.name) {
    return { success: false, error: "Profil-ID und Profilname sind erforderlich." };
  }

  profileRepository.save(profile);
  return { success: true, profile };
});

ipcMain.handle("delete-profile", (_event, profileId: string) => ({
  success: profileRepository.delete(profileId)
}));

ipcMain.handle("get-shops", () => ({
  success: true,
  shops: [...shops.values()]
}));

ipcMain.handle("register-shop", (_event, input) => {
  if (!input?.id || !input?.baseUrl) {
    return { success: false, error: "Shop id and baseUrl are required." };
  }

  shops.set(input.id, {
    id: input.id,
    name: input.name || input.id,
    baseUrl: input.baseUrl,
    platform: "shopify",
    config: input.config ?? {}
  });
  persistShops();

  return { success: true };
});

ipcMain.handle("create-task", (_event, input: TaskConfig) => {
  try {
    const task = orchestrator.createTask(input);
    broadcastTaskUpdate(task);
    return { success: true, taskId: task.id, task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

ipcMain.handle("start-task", async (_event, taskId: string) => {
  try {
    await orchestrator.startTask(taskId);

    const task = orchestrator.getTask(taskId);
    broadcastTaskUpdate(task);
    return task?.lastError
      ? { success: false, error: task.lastError, task }
      : { success: true, task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      task: orchestrator.getTask(taskId)
    };
  }
});

ipcMain.handle("pause-task", async (_event, taskId: string) => {
  try {
    await orchestrator.pauseTask(taskId);
    const task = orchestrator.getTask(taskId);
    broadcastTaskUpdate(task);
    return { success: true, task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      task: orchestrator.getTask(taskId)
    };
  }
});

ipcMain.handle("resume-task", async (_event, taskId: string) => {
  try {
    await orchestrator.resumeTask(taskId);
    const task = orchestrator.getTask(taskId);
    broadcastTaskUpdate(task);
    return { success: true, task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      task: orchestrator.getTask(taskId)
    };
  }
});

ipcMain.handle("stop-task", async (_event, taskId: string) => {
  try {
    orchestrator.cancelTask(taskId);
    const task = orchestrator.getTask(taskId);
    broadcastTaskUpdate(task);
    return { success: true, task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

ipcMain.handle("get-task-status", (_event, taskId: string) => {
  const task = orchestrator.getTask(taskId);
  return task
    ? { success: true, status: task.state, task }
    : { success: false, error: `Task ${taskId} not found.` };
});

ipcMain.handle("get-task-list", () => ({
  success: true,
  tasks: orchestrator.getAllTasks()
}));

ipcMain.handle("get-task-logs", async (_event, taskId: string, limit = 100) => {
  try {
    const logs = await taskStore.findLogsByTaskId(taskId, limit);
    return { success: true, logs };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

ipcMain.handle("get-system-status", async () => {
  const systemNode = readSystemNodeStatus();

  return {
    success: true,
    availableWorkers: orchestrator.getAvailableWorkers(),
    shopCount: shops.size,
    taskCount: orchestrator.getAllTasks().length,
    captchaProvider: "CapMonster",
    captchaApiKeyConfigured: Boolean(process.env["CAPMONSTER_API_KEY"]?.trim()),
    liveChallengeSupport: ["turnstile", "recaptcha", "shopify-checkpoint"],
    electronNodeVersion: process.versions.node,
    systemNodeRequirement: ">=20",
    systemNode,
    persistence: {
      type: "sqlite",
      ready: true,
      error: persistenceCoordinator.getLastError()
    },
    browserWorkerPool: await browserWorker.health()
  };
});

app.whenReady().then(async () => {
  try {
    await createBackend();
    mainWindow = createWindow();
    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("ARES Startfehler", `Backend/SQLite konnte nicht initialisiert werden.\n\n${message}`);
    app.quit();
  }
});

app.on("before-quit", event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;

  void (async () => {
    await browserWorker?.close().catch(() => undefined);
    orchestrator?.cleanup();
    await persistenceCoordinator?.close().catch(() => undefined);
    await taskStore?.close().catch(() => undefined);
    app.quit();
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
