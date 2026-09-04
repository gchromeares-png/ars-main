import { contextBridge, ipcRenderer } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";

const taskStatusListeners = new Map<Function, (_event: Electron.IpcRendererEvent, payload: unknown) => void>();
const monitorListeners = new Map<Function, (_event: Electron.IpcRendererEvent, payload: unknown) => void>();

interface CapmonsterKeyStatus {
  configured: boolean;
  source: "process-env" | ".env.txt" | ".env" | "none";
}

function isPlaceholderApiKey(value: string): boolean {
  const normalized = value.trim();
  return !normalized || /hier_deinen|your[_-]?key|replace[_-]?me|example/i.test(normalized);
}

function parseEnvValue(content: string, key: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    if (line.slice(0, separator).trim() !== key) continue;
    return line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

function readCapmonsterApiKey(): { key?: string; status: CapmonsterKeyStatus } {
  const fromProcess = process.env["CAPMONSTER_API_KEY"]?.trim();
  if (fromProcess && !isPlaceholderApiKey(fromProcess)) {
    return { key: fromProcess, status: { configured: true, source: "process-env" } };
  }

  const candidates: Array<{ filePath: string; source: CapmonsterKeyStatus["source"] }> = [
    { filePath: path.join(process.cwd(), ".env.txt"), source: ".env.txt" },
    { filePath: path.resolve(__dirname, "../../../.env.txt"), source: ".env.txt" },
    { filePath: path.join(process.cwd(), ".env"), source: ".env" },
    { filePath: path.resolve(__dirname, "../../../.env"), source: ".env" }
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.filePath)) continue;
    seen.add(candidate.filePath);
    try {
      if (!fs.existsSync(candidate.filePath)) continue;
      const value = parseEnvValue(fs.readFileSync(candidate.filePath, "utf8"), "CAPMONSTER_API_KEY");
      if (value && !isPlaceholderApiKey(value)) {
        return { key: value, status: { configured: true, source: candidate.source } };
      }
    } catch {}
  }

  return { status: { configured: false, source: "none" } };
}

function getCapmonsterApiKeyStatus(): CapmonsterKeyStatus {
  return readCapmonsterApiKey().status;
}

function testCapmonsterApiKey(): Promise<{
  success: boolean;
  configured: boolean;
  valid: boolean;
  source: CapmonsterKeyStatus["source"];
  balance?: number;
  latencyMs?: number;
  error?: string;
}> {
  const { key, status } = readCapmonsterApiKey();
  if (!key) {
    return Promise.resolve({
      success: false,
      configured: false,
      valid: false,
      source: status.source,
      error: "CAPMONSTER_API_KEY ist nicht gesetzt."
    });
  }

  return new Promise(resolve => {
    const startedAt = Date.now();
    const body = JSON.stringify({ clientKey: key });
    const request = https.request({
      hostname: "api.capmonster.cloud",
      path: "/getBalance",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      },
      timeout: 8_000
    }, response => {
      let payload = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        if (payload.length < 16_384) payload += chunk;
      });
      response.on("end", () => {
        const latencyMs = Date.now() - startedAt;
        try {
          const parsed = JSON.parse(payload || "{}") as {
            errorId?: number;
            errorCode?: string;
            errorDescription?: string;
            balance?: number;
          };
          const valid = parsed.errorId === 0 && typeof parsed.balance === "number";
          resolve({
            success: valid,
            configured: true,
            valid,
            source: status.source,
            balance: valid ? parsed.balance : undefined,
            latencyMs,
            error: valid ? undefined : (parsed.errorDescription || parsed.errorCode || `HTTP ${response.statusCode || 0}`)
          });
        } catch {
          resolve({
            success: false,
            configured: true,
            valid: false,
            source: status.source,
            latencyMs,
            error: `Ungültige Antwort vom CapMonster-Statusdienst (HTTP ${response.statusCode || 0}).`
          });
        }
      });
    });

    request.on("timeout", () => request.destroy(new Error("Timeout beim CapMonster-Key-Check.")));
    request.on("error", error => {
      resolve({
        success: false,
        configured: true,
        valid: false,
        source: status.source,
        latencyMs: Date.now() - startedAt,
        error: error.message
      });
    });
    request.write(body);
    request.end();
  });
}

const api = {
  getProfiles: () => ipcRenderer.invoke("get-profiles"),
  saveProfile: (profile: unknown) => ipcRenderer.invoke("save-profile", profile),
  deleteProfile: (profileId: string) => ipcRenderer.invoke("delete-profile", profileId),
  getProxies: () => ipcRenderer.invoke("get-proxies"),
  saveProxy: (proxy: unknown) => ipcRenderer.invoke("save-proxy", proxy),
  testProxy: (proxyId: string) => ipcRenderer.invoke("test-proxy", proxyId),
  testAllProxies: () => ipcRenderer.invoke("test-all-proxies"),
  deleteProxy: (proxyId: string) => ipcRenderer.invoke("delete-proxy", proxyId),
  getShops: () => ipcRenderer.invoke("get-shops"),
  registerShop: (config: unknown) => ipcRenderer.invoke("register-shop", config),
  createTask: (config: unknown) => ipcRenderer.invoke("create-task", config),
  setPaymentSession: (taskId: string, payment: unknown) => ipcRenderer.invoke("set-payment-session", taskId, payment),
  clearPaymentSession: (taskId: string) => ipcRenderer.invoke("clear-payment-session", taskId),
  startTask: (taskId: string) => ipcRenderer.invoke("start-task", taskId),
  pauseTask: (taskId: string) => ipcRenderer.invoke("pause-task", taskId),
  resumeTask: (taskId: string) => ipcRenderer.invoke("resume-task", taskId),
  stopTask: (taskId: string) => ipcRenderer.invoke("stop-task", taskId),
  updateDiscoveryKeywords: (taskId: string, keywords: string[]) => ipcRenderer.invoke("update-discovery-keywords", taskId, keywords),
  getFinalPurchaseSetting: () => ipcRenderer.invoke("get-final-purchase-setting"),
  setFinalPurchaseAllowed: (allowed: boolean) => ipcRenderer.invoke("set-final-purchase-allowed", allowed),
  getTaskStatus: (taskId: string) => ipcRenderer.invoke("get-task-status", taskId),
  getTaskList: () => ipcRenderer.invoke("get-task-list"),
  getTaskLogs: (taskId: string, limit = 100) => ipcRenderer.invoke("get-task-logs", taskId, limit),
  getProductMonitorEvents: (taskId: string, limit = 100) => ipcRenderer.invoke("get-product-monitor-events", taskId, limit),
  getSystemStatus: () => ipcRenderer.invoke("get-system-status"),
  getCapmonsterApiKeyStatus,
  testCapmonsterApiKey,
  onTaskStatusUpdate: (callback: (task: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    taskStatusListeners.set(callback, listener);
    ipcRenderer.on("task-status-update", listener);
    return () => {
      ipcRenderer.removeListener("task-status-update", listener);
      taskStatusListeners.delete(callback);
    };
  },
  onProductMonitorUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    monitorListeners.set(callback, listener);
    ipcRenderer.on("product-monitor-update", listener);
    return () => {
      ipcRenderer.removeListener("product-monitor-update", listener);
      monitorListeners.delete(callback);
    };
  },
  removeTaskStatusListener: (callback?: (task: unknown) => void) => {
    if (callback && taskStatusListeners.has(callback)) {
      const listener = taskStatusListeners.get(callback)!;
      ipcRenderer.removeListener("task-status-update", listener);
      taskStatusListeners.delete(callback);
    } else {
      ipcRenderer.removeAllListeners("task-status-update");
      taskStatusListeners.clear();
    }
  },
  removeProductMonitorListener: (callback?: (payload: unknown) => void) => {
    if (callback && monitorListeners.has(callback)) {
      const listener = monitorListeners.get(callback)!;
      ipcRenderer.removeListener("product-monitor-update", listener);
      monitorListeners.delete(callback);
    } else {
      ipcRenderer.removeAllListeners("product-monitor-update");
      monitorListeners.clear();
    }
  }
};

contextBridge.exposeInMainWorld("ares", api);

export type AresApi = typeof api;
