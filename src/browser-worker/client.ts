import { spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import * as path from "path";
import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { AresProfile } from "../profiles/models";
import type { ShopifyRuntimeShop } from "./runtime-types";
import type { BrowserWorkerHealth } from "./types";
import type { BrowserWorkerRequest, BrowserWorkerResponse } from "./protocol";

interface PendingRequest {
  resolve: (value: BrowserWorkerResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface BrowserWorkerProcessHealth {
  pid?: number;
  nodeVersion?: string;
  activeTasks: number;
  browser?: BrowserWorkerHealth;
  running: boolean;
  lastHeartbeatAt?: Date;
}

export class BrowserWorkerProcessClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly taskIds = new Set<string>();
  private pid?: number;
  private nodeVersion?: string;
  private closing = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatInFlight = false;
  private lastHeartbeatAt?: Date;

  constructor(
    private readonly requestTimeoutMs: number,
    private readonly profileRoot: string | undefined,
    private readonly onExit: (client: BrowserWorkerProcessClient, error: Error) => void,
    private readonly heartbeatIntervalMs = 30_000,
    private readonly heartbeatTimeoutMs = 10_000,
    private readonly executeTimeoutMs = 65 * 60_000
  ) {}

  get load(): number {
    return this.taskIds.size;
  }

  owns(taskId: string): boolean {
    return this.taskIds.has(taskId);
  }

  async execute(task: Task, shop: ShopifyRuntimeShop, profile: AresProfile): Promise<boolean> {
    this.taskIds.add(task.id);
    try {
      await this.ensureReady();
      const response = await this.request({
        type: "execute",
        requestId: randomUUID(),
        task,
        shop,
        profile
      }, this.executeTimeoutMs);
      if (response.type !== "execute-result") {
        throw new Error(`Unerwartete Browser-Worker-Antwort: ${response.type}`);
      }

      task.config = response.taskPatch.config;
      task.lastError = response.taskPatch.lastError;
      return response.success;
    } finally {
      this.taskIds.delete(task.id);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    if (!this.child) {
      this.taskIds.delete(taskId);
      return;
    }

    await this.ensureReady();
    try {
      await this.request({ type: "cancel", requestId: randomUUID(), taskId }, 10_000);
    } finally {
      this.taskIds.delete(taskId);
    }
  }

  async health(): Promise<BrowserWorkerProcessHealth> {
    if (!this.child || this.child.killed) {
      return { activeTasks: this.taskIds.size, running: false, lastHeartbeatAt: this.lastHeartbeatAt };
    }

    await this.ensureReady();
    const response = await this.request({ type: "health", requestId: randomUUID() }, this.heartbeatTimeoutMs);
    if (response.type !== "health-result") {
      throw new Error(`Unerwartete Health-Antwort: ${response.type}`);
    }

    this.lastHeartbeatAt = new Date();
    return {
      pid: response.pid,
      nodeVersion: response.nodeVersion,
      activeTasks: this.taskIds.size,
      browser: { ...response.health, startedAt: new Date(response.health.startedAt) },
      running: true,
      lastHeartbeatAt: this.lastHeartbeatAt
    };
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) return;
    this.closing = true;
    this.stopHeartbeat();

    try {
      await this.request({ type: "shutdown", requestId: randomUUID() }, 4_000);
    } catch {
      if (!child.killed) child.kill();
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.child || this.child.killed) this.spawnWorker();
    if (!this.ready) throw new Error("Browser Worker konnte nicht initialisiert werden.");
    return this.ready;
  }

  private spawnWorker(): void {
    // @ts-ignore
    const nodeExecutable = process.env.ARES_NODE_EXECUTABLE?.trim() || "node";
    const workerScript = path.join(__dirname, "worker.js");
    const child = spawn(nodeExecutable, [workerScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ARES_BROWSER_WORKER: "1",
        ...(this.profileRoot ? { ARES_BROWSER_PROFILE_ROOT: this.profileRoot } : {})
      }
    });

    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.lastHeartbeatAt = undefined;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.handleStdout(String(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-8_000);
    });
    child.on("error", error => this.handleWorkerExit(new Error(
      `Browser Worker konnte nicht mit Node-Executable "${nodeExecutable}" gestartet werden: ${error.message}`
    )));
    child.on("exit", (code, signal) => {
      const details = this.stderrBuffer.trim();
      this.handleWorkerExit(new Error(
        `Browser Worker beendet (code=${String(code)}, signal=${String(signal)}).${details ? ` ${details}` : ""}`
      ));
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let message: BrowserWorkerResponse;
      try {
        message = JSON.parse(line) as BrowserWorkerResponse;
      } catch {
        continue;
      }

      if (message.type === "ready") {
        this.pid = message.pid;
        this.nodeVersion = message.nodeVersion;
        this.readyResolve?.();
        this.readyResolve = undefined;
        this.readyReject = undefined;
        this.lastHeartbeatAt = new Date();
        this.startHeartbeat();
        continue;
      }

      const requestId = "requestId" in message ? message.requestId : undefined;
      if (!requestId) continue;
      const pending = this.pending.get(requestId);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);

      if (message.type === "error") pending.reject(new Error(message.error));
      else pending.resolve(message);
    }
  }

  private request(request: BrowserWorkerRequest, timeoutMs = this.requestTimeoutMs): Promise<BrowserWorkerResponse> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error("Browser Worker ist nicht aktiv."));

    return new Promise<BrowserWorkerResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`Browser Worker Timeout für ${request.type}.`);
        this.pending.delete(request.requestId);
        reject(error);
        this.recycleWorker(error);
      }, timeoutMs);
      timeout.unref();

      this.pending.set(request.requestId, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify(request)}\n`, error => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(request.requestId);
        reject(error);
        this.recycleWorker(error);
      });
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatInFlight = false;
  }

  private async runHeartbeat(): Promise<void> {
    if (this.closing || this.heartbeatInFlight || !this.child || this.child.killed) return;
    this.heartbeatInFlight = true;

    try {
      const response = await this.request({ type: "health", requestId: randomUUID() }, this.heartbeatTimeoutMs);
      if (response.type !== "health-result") {
        throw new Error(`Unerwartete Heartbeat-Antwort: ${response.type}`);
      }
      this.lastHeartbeatAt = new Date();
    } catch (error) {
      if (this.child) {
        const reason = error instanceof Error ? error : new Error(String(error));
        this.recycleWorker(new Error(`Browser Worker Heartbeat fehlgeschlagen: ${reason.message}`));
      }
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private recycleWorker(error: Error): void {
    const child = this.child;
    if (!child) return;
    if (!child.killed) child.kill();
    this.handleWorkerExit(error);
  }

  private handleWorkerExit(error: Error): void {
    const wasCurrent = Boolean(this.child);
    this.stopHeartbeat();
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.ready = undefined;
    this.child = undefined;
    this.pid = undefined;
    this.nodeVersion = undefined;
    this.taskIds.clear();

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (wasCurrent && !this.closing) this.onExit(this, error);
    this.closing = false;
  }
}

export class BrowserWorkerPoolClient implements ITaskExecutor {
  private readonly clients: BrowserWorkerProcessClient[];
  private readonly taskOwners = new Map<string, BrowserWorkerProcessClient>();
  private lastWorkerError?: string;

  constructor(
    private readonly getShop: (shopId: string) => ShopifyRuntimeShop | undefined,
    private readonly getProfile: (profileId: string) => AresProfile | undefined,
    options: {
      processCount?: number;
      requestTimeoutMs?: number;
      executeTimeoutMs?: number;
      heartbeatIntervalMs?: number;
      heartbeatTimeoutMs?: number;
      profileRoot?: string;
    } = {}
  ) {
    // @ts-ignore
    const requestedCount = options.processCount ?? Number(process.env.ARES_BROWSER_WORKER_PROCESSES ?? "1");
    const processCount = Number.isFinite(requestedCount)
      ? Math.min(4, Math.max(1, Math.floor(requestedCount)))
      : 1;
    const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    const executeTimeoutMs = options.executeTimeoutMs ?? 65 * 60_000;
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;

    this.clients = Array.from({ length: processCount }, () => new BrowserWorkerProcessClient(
      requestTimeoutMs,
      options.profileRoot,
      (client, error) => this.handleClientExit(client, error),
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      executeTimeoutMs
    ));
  }

  async execute(task: Task): Promise<boolean> {
    const shopId = task.config.shopId;
    if (!shopId) {
      task.lastError = "Task hat keine shopId.";
      return false;
    }

    const profileId = String((task.config.data ?? {})["profileId"] ?? "");
    if (!profileId) {
      task.lastError = "Kein Profil für den Task ausgewählt.";
      return false;
    }

    const shop = this.getShop(shopId);
    if (!shop) {
      task.lastError = `Shop ${shopId} ist nicht registriert.`;
      return false;
    }

    const profile = this.getProfile(profileId);
    if (!profile) {
      task.lastError = `Profil ${profileId} ist nicht registriert.`;
      return false;
    }

    const client = this.taskOwners.get(task.id) ?? this.leastLoadedClient();
    this.taskOwners.set(task.id, client);
    try {
      const success = await client.execute(task, shop, profile);
      return success;
    } catch (error) {
      task.lastError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.taskOwners.delete(task.id);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const owner = this.taskOwners.get(taskId);
    if (!owner) return;
    try {
      await owner.cancelTask(taskId);
    } finally {
      this.taskOwners.delete(taskId);
    }
  }

  async health(): Promise<{ workers: BrowserWorkerProcessHealth[]; lastError?: string }> {
    const workers = await Promise.all(this.clients.map(client => client.health().catch(() => ({
      activeTasks: client.load,
      running: false
    }))));
    return { workers, lastError: this.lastWorkerError };
  }

  async close(): Promise<void> {
    this.taskOwners.clear();
    await Promise.allSettled(this.clients.map(client => client.close()));
  }

  private leastLoadedClient(): BrowserWorkerProcessClient {
    return this.clients.reduce((best, current) => current.load < best.load ? current : best);
  }

  private handleClientExit(client: BrowserWorkerProcessClient, error: Error): void {
    this.lastWorkerError = error.message;
    for (const [taskId, owner] of this.taskOwners) {
      if (owner === client) this.taskOwners.delete(taskId);
    }
  }
}

export { BrowserWorkerPoolClient as BrowserWorkerClient };
