import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TaskOrchestrator } from "../orchestrator";
import { WorkerMock } from "../mocks";
import { BrowserWorkerPoolClient } from "../browser-worker/client";
import { removeProfileUserDataDir } from "../browser-worker/profile-session-manager";
import { TaskConfig, TaskState } from "../models";
import { ProfileRepository } from "../profiles/profile-repository";
import { AresProfile } from "../profiles/models";
import { ProxyRepository } from "../proxies/proxy-repository";
import { ProxyHealthService } from "../proxies/proxy-health-service";
import type { AresProxy } from "../proxies/models";
import type { CheckoutPaymentSession, PaymentMethod } from "../payments/models";
import { EphemeralPaymentExecutor } from "../payments/ephemeral-payment-executor";
import { SqliteTaskStore } from "../persistence/sqlite-task-store";
import { TaskPersistenceCoordinator } from "../persistence/task-persistence-coordinator";
import {
  COMMERCE_PLATFORMS,
  CommerceShop,
  normalizeCommercePlatform
} from "../commerce/platforms";
import { CommerceTaskExecutorRouter } from "../commerce/task-executor-router";
import { CommerceProductApiRouter } from "../commerce/product-api/router";
import { CommerceMonitorService, isCommerceMonitorTask } from "../monitor/commerce-monitor-service";
import { MonitorAutoCheckoutCoordinator } from "../monitor/auto-checkout-coordinator";
import { PassiveHttpPreCheckoutGate } from "../monitor/pre-checkout-gate";
import { isEarlyGateChildTask, normalizeDiscoveryKeywords } from "../monitor/early-gate";
import {
  isCapMonsterApiKeyConfigured,
  loadCapMonsterApiKeyFromEnvFiles,
  testCapMonsterApiKey
} from "./capmonster-api-key-health";
import { ProfileBrowserController } from "./profile-browser-controller";

let mainWindow: BrowserWindow | null = null;
let orchestrator: TaskOrchestrator;
let browserWorker: BrowserWorkerPoolClient;
let profileBrowserController: ProfileBrowserController;
let browserProfileRoot = "";
let commerceExecutor: CommerceTaskExecutorRouter;
let commerceMonitor: CommerceMonitorService;
let autoCheckoutCoordinator: MonitorAutoCheckoutCoordinator;
let taskStore: SqliteTaskStore;
let persistenceCoordinator: TaskPersistenceCoordinator;
let quitting = false;
let allowFinalPurchase = false;

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

function broadcastMonitorUpdate(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("product-monitor-update", payload);
    }
  }
}

const shops = new Map<string, CommerceShop>();
const profileRepository = new ProfileRepository();
const proxyRepository = new ProxyRepository();
const proxyHealthService = new ProxyHealthService();
const paymentSessions = new Map<string, CheckoutPaymentSession>();

function normalizeStoredShop(input: any): CommerceShop | undefined {
  if (!input?.id || !input?.baseUrl) return undefined;

  const platform = normalizeCommercePlatform(input.platform ?? "shopify");
  if (!platform) return undefined;

  return {
    id: String(input.id).trim(),
    name: String(input.name || input.id).trim(),
    baseUrl: String(input.baseUrl).trim(),
    platform,
    config: input.config && typeof input.config === "object" ? input.config : {}
  };
}

function normalizePaymentSession(input: any): CheckoutPaymentSession | undefined {
  const allowedMethods = new Set<PaymentMethod>(["card", "paypal", "shop-pay", "klarna", "other"]);
  const method = String(input?.method ?? "").trim() as PaymentMethod;
  if (!allowedMethods.has(method)) return undefined;

  const session: CheckoutPaymentSession = {
    method,
    label: typeof input?.label === "string" ? input.label.trim().slice(0, 120) || undefined : undefined
  };

  if (method === "card" && input?.card && typeof input.card === "object") {
    session.card = {
      holderName: typeof input.card.holderName === "string" ? input.card.holderName.trim().slice(0, 120) || undefined : undefined,
      cardNumber: typeof input.card.cardNumber === "string" ? input.card.cardNumber.replace(/\s+/g, "").slice(0, 24) || undefined : undefined,
      expiry: typeof input.card.expiry === "string" ? input.card.expiry.trim().slice(0, 12) || undefined : undefined,
      securityCode: typeof input.card.securityCode === "string" ? input.card.securityCode.trim().slice(0, 8) || undefined : undefined
    };
  }

  return session;
}

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
          const shop = normalizeStoredShop(item);
          if (shop) shops.set(shop.id, shop);
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
  proxyRepository.setStoragePath(path.join(userData, "proxies.json"));
  loadShops();

  browserProfileRoot = path.join(userData, "browser-profiles");
  profileBrowserController = new ProfileBrowserController(
    browserProfileRoot,
    proxyId => proxyRepository.get(proxyId)
  );

  // Hard runtime default: final purchase is never enabled by persisted/UI state.
  allowFinalPurchase = false;
  browserWorker = new BrowserWorkerPoolClient(
    shopId => shops.get(shopId),
    profileId => profileRepository.get(profileId),
    {
      profileRoot: browserProfileRoot,
      getProxy: proxyId => proxyRepository.get(proxyId)
    }
  );

  taskStore = await SqliteTaskStore.open(path.join(userData, "ares.sqlite"));

  const productApiRouter = new CommerceProductApiRouter();
  commerceMonitor = new CommerceMonitorService(
    shopId => shops.get(shopId),
    productApiRouter,
    taskStore,
    {
      preCheckoutGate: new PassiveHttpPreCheckoutGate(),
      onEvent: (taskId, event) => {
        broadcastMonitorUpdate({ taskId, event });
        void autoCheckoutCoordinator?.handleProductEvent(taskId, event).catch(error => {
          const task = orchestrator?.getTask(taskId);
          if (task) {
            task.lastError = error instanceof Error ? error.message : String(error);
            broadcastTaskUpdate(task);
          }
        });
      },
      onGateEvent: (taskId, event) => {
        broadcastMonitorUpdate({ taskId, gateEvent: event });
        void autoCheckoutCoordinator?.handleGateEvent(taskId, event).catch(error => {
          const task = orchestrator?.getTask(taskId);
          if (task) {
            task.lastError = error instanceof Error ? error.message : String(error);
            broadcastTaskUpdate(task);
          }
        });
      }
    }
  );

  const paymentAwareBrowserWorker = new EphemeralPaymentExecutor(
    browserWorker,
    taskId => paymentSessions.get(taskId)
  );

  commerceExecutor = new CommerceTaskExecutorRouter(shopId => shops.get(shopId));
  commerceExecutor.register("shopify", paymentAwareBrowserWorker);
  commerceExecutor.registerMonitorExecutor(commerceMonitor);
  commerceExecutor.registerEarlyGateExecutor(paymentAwareBrowserWorker);
  await commerceExecutor.setFinalPurchaseAllowed(false);

  orchestrator = new TaskOrchestrator(taskStore, commerceExecutor);
  autoCheckoutCoordinator = new MonitorAutoCheckoutCoordinator(orchestrator, {
    getPaymentSession: taskId => paymentSessions.get(taskId),
    setPaymentSession: (taskId, session) => paymentSessions.set(taskId, session),
    onTriggered: (parent, child, event) => {
      broadcastMonitorUpdate({
        taskId: parent.id,
        event,
        autoCheckout: { childTaskId: child.id, status: "triggered" }
      });
      broadcastTaskUpdate(parent);
      broadcastTaskUpdate(child);
    },
    onGateTriggered: (parent, child, event) => {
      broadcastMonitorUpdate({
        taskId: parent.id,
        gateEvent: event,
        earlyGate: { childTaskId: child.id, status: "triggered" }
      });
      broadcastTaskUpdate(parent);
      broadcastTaskUpdate(child);
    }
  });
  persistenceCoordinator = new TaskPersistenceCoordinator(orchestrator, taskStore);
  await orchestrator.initialize();

  const configuredConcurrency = Number(process.env["ARES_MAX_CONCURRENT_TASKS"] ?? "4");
  const maxConcurrentTasks = Number.isFinite(configuredConcurrency)
    ? Math.min(16, Math.max(1, Math.floor(configuredConcurrency)))
    : 4;
  for (let index = 1; index <= maxConcurrentTasks; index++) {
    orchestrator.addWorker(new WorkerMock(`browser-slot-${index}`));
  }

  const forwardTask = (task: any) => {
    if (task?.id && [TaskState.SUCCESS, TaskState.FAILED, TaskState.CANCELLED].includes(task.state)) {
      paymentSessions.delete(String(task.id));
    }
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
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devServerUrl = process.env["ARES_UI_URL"];
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, "../../ares/index.html"));

  return win;
}

function findActiveTaskForProfile(profileId: string) {
  return orchestrator?.getAllTasks().find(task => {
    if ([TaskState.SUCCESS, TaskState.FAILED, TaskState.CANCELLED].includes(task.state)) return false;
    const data = task.config.data ?? {};
    const action = data["monitorAction"] as { profileId?: string } | undefined;
    const assigned = String(data["profileId"] ?? action?.profileId ?? "").trim();
    return assigned === profileId;
  });
}

ipcMain.handle("get-profiles", () => ({ success: true, profiles: profileRepository.getAll() }));

ipcMain.handle("save-profile", (_event, profile: AresProfile) => {
  if (!profile?.id || !profile?.name) {
    return { success: false, error: "Profil-ID und Profilname sind erforderlich." };
  }
  if (profile.preferredProxyId && !proxyRepository.get(profile.preferredProxyId)) {
    return { success: false, error: `Standard-Proxy ${profile.preferredProxyId} existiert nicht.` };
  }
  profileRepository.save(profile);
  return { success: true, profile };
});

ipcMain.handle("get-profile-browser-status", (_event, profileId: string) => {
  const id = String(profileId ?? "").trim();
  if (!id || !profileRepository.get(id)) return { success: false, error: "Profil wurde nicht gefunden." };
  return { success: true, status: profileBrowserController.status(id) };
});

ipcMain.handle("open-profile-browser", async (_event, profileId: string, startUrl?: string) => {
  const id = String(profileId ?? "").trim();
  const profile = profileRepository.get(id);
  if (!profile) return { success: false, error: `Profil ${id || "(ohne ID)"} wurde nicht gefunden.` };

  const activeTask = findActiveTaskForProfile(id);
  if (activeTask) {
    return { success: false, error: `Profil ist aktuell durch Task ${activeTask.config.name} belegt.` };
  }

  try {
    const status = await profileBrowserController.open(profile, startUrl);
    return { success: true, status };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("close-profile-browser", async (_event, profileId: string) => {
  const id = String(profileId ?? "").trim();
  if (!id) return { success: false, error: "Profil-ID fehlt." };
  try {
    const status = await profileBrowserController.close(id);
    return { success: true, status };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("delete-profile", async (_event, profileId: string) => {
  const id = String(profileId ?? "").trim();
  const profile = profileRepository.get(id);
  if (!profile) return { success: false, error: "Profil wurde nicht gefunden." };
  if (profileBrowserController.isOpen(id)) {
    return { success: false, error: "Profil-Browser ist noch geöffnet. Browser zuerst schließen." };
  }

  const activeTask = findActiveTaskForProfile(id);
  if (activeTask) {
    return { success: false, error: `Profil ist noch Task ${activeTask.config.name} zugeordnet.` };
  }

  if (!profileRepository.delete(id)) return { success: false, error: "Profil konnte nicht gelöscht werden." };
  try {
    removeProfileUserDataDir(id, browserProfileRoot);
    return { success: true };
  } catch (error) {
    profileRepository.save(profile);
    return {
      success: false,
      error: `Browserdaten konnten nicht sicher gelöscht werden: ${error instanceof Error ? error.message : String(error)}`
    };
  }
});

ipcMain.handle("get-proxies", () => ({ success: true, proxies: proxyRepository.getAll() }));

ipcMain.handle("save-proxy", (_event, input: AresProxy) => {
  try {
    const proxy = proxyRepository.save(input);
    return { success: true, proxy };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("test-proxy", async (_event, proxyId: string) => {
  const id = String(proxyId ?? "").trim();
  const proxy = proxyRepository.get(id);
  if (!proxy) return { success: false, error: `Proxy ${id || "(ohne ID)"} wurde nicht gefunden.` };

  const health = await proxyHealthService.test(proxy);
  const saved = proxyRepository.save({ ...proxy, health });
  return { success: health.status === "online", proxy: saved, health, error: health.error };
});

ipcMain.handle("test-all-proxies", async () => {
  const results = [];
  for (const proxy of proxyRepository.getAll()) {
    const health = await proxyHealthService.test(proxy);
    const saved = proxyRepository.save({ ...proxy, health });
    results.push({ proxyId: proxy.id, success: health.status === "online", health, proxy: saved });
  }
  return { success: true, results, proxies: proxyRepository.getAll() };
});

ipcMain.handle("delete-proxy", (_event, proxyId: string) => {
  const id = String(proxyId ?? "").trim();
  if (!id) return { success: false, error: "Proxy-ID fehlt." };

  const assignedProfile = profileRepository.getAll().find(profile => profile.preferredProxyId === id);
  if (assignedProfile) {
    return { success: false, error: `Proxy ist als Standard in Profil ${assignedProfile.name} zugeordnet.` };
  }

  const activeTask = orchestrator.getAllTasks().find(task => {
    if ([TaskState.SUCCESS, TaskState.FAILED, TaskState.CANCELLED].includes(task.state)) return false;
    const selection = task.config.data?.["proxySelection"] as { mode?: string; proxyId?: string } | undefined;
    const action = task.config.data?.["monitorAction"] as {
      mode?: string;
      proxySelection?: { mode?: string; proxyId?: string };
    } | undefined;
    return (selection?.mode === "proxy" && selection.proxyId === id)
      || (action?.mode === "auto-checkout" && action.proxySelection?.mode === "proxy" && action.proxySelection.proxyId === id);
  });
  if (activeTask) {
    return { success: false, error: `Proxy ist noch Task ${activeTask.config.name} zugeordnet.` };
  }

  return { success: proxyRepository.delete(id) };
});

ipcMain.handle("set-payment-session", (_event, taskId: string, input: unknown) => {
  const id = String(taskId ?? "").trim();
  if (!id || !orchestrator.getTask(id)) {
    return { success: false, error: "Task für Zahlungsdaten wurde nicht gefunden." };
  }

  const session = normalizePaymentSession(input);
  if (!session) {
    paymentSessions.delete(id);
    return { success: false, error: "Ungültige Zahlungsart." };
  }

  paymentSessions.set(id, session);
  return { success: true, method: session.method };
});

ipcMain.handle("clear-payment-session", (_event, taskId: string) => {
  paymentSessions.delete(String(taskId ?? ""));
  return { success: true };
});

ipcMain.handle("get-shops", () => ({
  success: true,
  shops: [...shops.values()],
  platforms: COMMERCE_PLATFORMS,
  executorPlatforms: commerceExecutor?.listExecutorPlatforms() ?? [],
  monitorReady: commerceExecutor?.hasMonitorExecutor() ?? false,
  earlyGateReady: commerceExecutor?.hasEarlyGateExecutor() ?? false
}));

ipcMain.handle("register-shop", (_event, input) => {
  if (!input?.id || !input?.baseUrl) {
    return { success: false, error: "Shop-ID und Shop-URL sind erforderlich." };
  }

  const platform = normalizeCommercePlatform(input.platform ?? "shopify");
  if (!platform) {
    return {
      success: false,
      error: `Unbekannte Commerce-Plattform. Unterstützte Typen: ${COMMERCE_PLATFORMS.join(", ")}`
    };
  }

  const shop: CommerceShop = {
    id: String(input.id).trim(),
    name: String(input.name || input.id).trim(),
    baseUrl: String(input.baseUrl).trim(),
    platform,
    config: input.config && typeof input.config === "object" ? input.config : {}
  };

  shops.set(shop.id, shop);
  persistShops();

  return {
    success: true,
    shop,
    executorReady: commerceExecutor.hasExecutor(platform),
    monitorReady: commerceExecutor.hasMonitorExecutor(),
    earlyGateReady: commerceExecutor.hasEarlyGateExecutor()
  };
});

ipcMain.handle("create-task", (_event, input: TaskConfig) => {
  try {
    const task = orchestrator.createTask(input);
    broadcastTaskUpdate(task);
    return { success: true, taskId: task.id, task };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("start-task", async (_event, taskId: string) => {
  try {
    const existing = orchestrator.getTask(taskId);
    if (!existing) return { success: false, error: `Task ${taskId} not found.` };

    if (isCommerceMonitorTask(existing)) {
      void orchestrator.startTask(taskId).catch(error => {
        existing.lastError = error instanceof Error ? error.message : String(error);
        broadcastTaskUpdate(existing);
      });
      broadcastTaskUpdate(existing);
      return { success: true, task: existing };
    }

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
    return { success: false, error: error instanceof Error ? error.message : String(error), task: orchestrator.getTask(taskId) };
  }
});

ipcMain.handle("resume-task", async (_event, taskId: string) => {
  try {
    await orchestrator.resumeTask(taskId);
    const task = orchestrator.getTask(taskId);
    broadcastTaskUpdate(task);
    return { success: true, task };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), task: orchestrator.getTask(taskId) };
  }
});

ipcMain.handle("stop-task", async (_event, taskId: string) => {
  try {
    paymentSessions.delete(taskId);
    orchestrator.cancelTask(taskId);
    const task = orchestrator.getTask(taskId);
    commerceMonitor.resetTask(taskId);
    broadcastTaskUpdate(task);
    return { success: true, task };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("update-discovery-keywords", async (_event, taskId: string, input: unknown) => {
  try {
    const id = String(taskId ?? "").trim();
    const task = orchestrator.getTask(id);
    if (!task || !isEarlyGateChildTask(task)) {
      return { success: false, error: "Early-Gate-Browser-Child wurde nicht gefunden." };
    }
    if (task.state !== TaskState.POST_QUEUE_DISCOVERY) {
      return { success: false, error: "Discovery-Keywords können nur während POST_QUEUE_DISCOVERY geändert werden." };
    }

    const requested = normalizeDiscoveryKeywords(input);
    const keywords = await commerceExecutor.updateDiscoveryKeywords(id, requested);
    const postQueue = task.config.data?.["postQueueDiscovery"] as Record<string, unknown> | undefined;
    task.config.data = {
      ...(task.config.data ?? {}),
      postQueueDiscovery: {
        ...(postQueue ?? {}),
        keywords,
        updatedAt: new Date().toISOString()
      }
    };
    broadcastTaskUpdate(task);
    return { success: true, taskId: id, keywords };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("get-final-purchase-setting", () => ({
  success: true,
  allowFinalPurchase
}));

ipcMain.handle("set-final-purchase-allowed", async (_event, input: unknown) => {
  const requested = input === true;
  allowFinalPurchase = requested;
  try {
    await commerceExecutor.setFinalPurchaseAllowed(requested);
    return { success: true, allowFinalPurchase };
  } catch (error) {
    // Fail closed if any worker cannot confirm the global setting.
    allowFinalPurchase = false;
    await commerceExecutor.setFinalPurchaseAllowed(false).catch(() => undefined);
    return {
      success: false,
      allowFinalPurchase: false,
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

ipcMain.handle("get-task-list", () => ({ success: true, tasks: orchestrator.getAllTasks() }));

ipcMain.handle("get-task-logs", async (_event, taskId: string, limit = 100) => {
  try {
    const logs = await taskStore.findLogsByTaskId(taskId, limit);
    return { success: true, logs };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("get-product-monitor-events", async (_event, taskId: string, limit = 100) => {
  try {
    const events = await taskStore.findProductMonitorEventsByTaskId(taskId, limit);
    return { success: true, events };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("test-capmonster-api-key", async () => testCapMonsterApiKey());

ipcMain.handle("get-system-status", async () => {
  const systemNode = readSystemNodeStatus();

  return {
    success: true,
    availableWorkers: orchestrator.getAvailableWorkers(),
    shopCount: shops.size,
    taskCount: orchestrator.getAllTasks().length,
    profileCount: profileRepository.getAll().length,
    proxyCount: proxyRepository.getAll().length,
    commercePlatforms: COMMERCE_PLATFORMS,
    commerceExecutorPlatforms: commerceExecutor.listExecutorPlatforms(),
    commerceMonitorReady: commerceExecutor.hasMonitorExecutor(),
    earlyGateReady: commerceExecutor.hasEarlyGateExecutor(),
    allowFinalPurchase,
    captchaProvider: "CapMonster",
    captchaApiKeyConfigured: isCapMonsterApiKeyConfigured(),
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
    loadCapMonsterApiKeyFromEnvFiles(app.getAppPath());
    await createBackend();
    mainWindow = createWindow();
    mainWindow.on("closed", () => { mainWindow = null; });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
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
    allowFinalPurchase = false;
    await commerceExecutor?.setFinalPurchaseAllowed(false).catch(() => undefined);
    paymentSessions.clear();
    await profileBrowserController?.closeAll().catch(() => undefined);
    await commerceExecutor?.close().catch(() => undefined);
    orchestrator?.cleanup();
    await persistenceCoordinator?.close().catch(() => undefined);
    await taskStore?.close().catch(() => undefined);
    app.quit();
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
