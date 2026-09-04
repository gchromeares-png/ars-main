import { Component, Input, OnDestroy, OnInit } from "@angular/core";
import { ElectronService } from "../services/electron.service";

interface QueueView {
  active?: boolean;
  phase?: string;
  position?: number;
  timeToWaitSeconds?: number;
  statusText?: string;
  source?: string;
  detectedAt?: string;
  updatedAt?: string;
  elapsedMs?: number;
  maxWaitMs?: number;
}

@Component({
  selector: "app-runtime-control",
  templateUrl: "./runtime-control.component.html",
  styleUrls: ["./runtime-control.component.scss"]
})
export class RuntimeControlComponent implements OnInit, OnDestroy {
  @Input() system: any;
  @Input() tasks: any[] = [];

  runtimeSystem: any;
  actionMessage = "";
  purchaseChanging = false;
  apiKeyTesting = false;
  apiKeyCheck: any;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly electron: ElectronService) {}

  ngOnInit(): void {
    this.runtimeSystem = this.system;
    void this.refreshRuntime();
    this.refreshTimer = setInterval(() => void this.refreshRuntime(), 10_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  get activeQueues(): any[] {
    return this.tasks.filter(task => {
      const queue = this.getQueue(task);
      return task.state === "WAITING_QUEUE" || Boolean(queue?.active);
    });
  }

  get checkoutReadyTasks(): any[] {
    return this.tasks.filter(task => task.state === "CHECKOUT" && this.isEarlyGateChild(task));
  }

  get workers(): any[] {
    return this.currentSystem?.browserWorkerPool?.workers ?? [];
  }

  get watchdog(): any {
    return this.currentSystem?.browserWorkerPool?.watchdog ?? {};
  }

  get finalPurchaseAllowed(): boolean {
    return this.currentSystem?.allowFinalPurchase === true;
  }

  get apiKeyConfigured(): boolean {
    return this.currentSystem?.captchaApiKeyConfigured === true;
  }

  get apiKeyCheckLabel(): string {
    if (!this.apiKeyCheck) return "NOCH NICHT GETESTET";
    if (this.apiKeyCheck.valid === true) return "GÜLTIG";
    if (this.apiKeyCheck.valid === false) return "UNGÜLTIG";
    return "CHECK FEHLER";
  }

  get healthyWorkerCount(): number {
    return this.workers.filter(worker => worker.running && worker.browser?.state !== "degraded").length;
  }

  get activeWorkerTaskCount(): number {
    return this.workers.reduce((sum, worker) => sum + Number(worker.activeTasks ?? 0), 0);
  }

  get restartCount(): number {
    return this.workers.reduce((sum, worker) => sum + Number(worker.restartCount ?? 0), 0);
  }

  get lastWorkerError(): string {
    return String(this.currentSystem?.browserWorkerPool?.lastError ?? "");
  }

  getQueue(task: any): QueueView | undefined {
    const data = task?.config?.data;
    const queue = data?.queueStatus;
    return queue && typeof queue === "object" ? queue as QueueView : undefined;
  }

  queuePosition(task: any): string {
    const position = this.getQueue(task)?.position;
    return typeof position === "number" && Number.isFinite(position)
      ? Math.max(0, Math.floor(position)).toLocaleString("de-DE")
      : "–";
  }

  queueWait(task: any): string {
    const seconds = this.getQueue(task)?.timeToWaitSeconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "wird ermittelt";
    return this.formatDuration(seconds * 1_000);
  }

  queueElapsed(task: any): string {
    return this.formatDuration(Number(this.getQueue(task)?.elapsedMs ?? 0));
  }

  queueMaximum(task: any): string {
    return this.formatDuration(Number(this.getQueue(task)?.maxWaitMs ?? 60 * 60_000));
  }

  queueProgress(task: any): number {
    const queue = this.getQueue(task);
    const max = Number(queue?.maxWaitMs ?? 0);
    const elapsed = Number(queue?.elapsedMs ?? 0);
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(elapsed)) return 0;
    return Math.min(100, Math.max(0, (elapsed / max) * 100));
  }

  queueStatusText(task: any): string {
    const queue = this.getQueue(task);
    return queue?.statusText || "Warteschlange aktiv – Browser bleibt verbunden.";
  }

  workerState(worker: any): string {
    if (!worker.running) return "OFFLINE";
    if (worker.browser?.state === "degraded") return "DEGRADED";
    return worker.activeTasks > 0 ? "BUSY" : "HEALTHY";
  }

  workerHeartbeat(worker: any): string {
    if (!worker.lastHeartbeatAt) return "noch kein Heartbeat";
    const value = new Date(worker.lastHeartbeatAt);
    return Number.isNaN(value.getTime()) ? "Heartbeat unbekannt" : value.toLocaleTimeString("de-DE");
  }

  watchdogLabel(): string {
    const interval = Number(this.watchdog.heartbeatIntervalMs ?? 30_000);
    const timeout = Number(this.watchdog.heartbeatTimeoutMs ?? 10_000);
    return `${Math.round(interval / 1_000)}s Heartbeat · ${Math.round(timeout / 1_000)}s Timeout`;
  }

  async testCapmonsterApiKey(): Promise<void> {
    if (this.apiKeyTesting) return;
    this.apiKeyTesting = true;
    this.actionMessage = "";
    try {
      const result = await this.electron.testCapmonsterApiKey();
      this.apiKeyCheck = result;
      if (result?.valid === true) {
        this.actionMessage = "CapMonster API-Key ist gültig.";
      } else if (result?.valid === false) {
        this.actionMessage = `CapMonster API-Key wurde abgelehnt${result.errorCode ? ` · ${result.errorCode}` : ""}.`;
      } else {
        this.actionMessage = result?.error || "CapMonster API-Key konnte nicht geprüft werden.";
      }
      await this.refreshRuntime();
    } finally {
      this.apiKeyTesting = false;
    }
  }

  async setFinalPurchaseAllowed(allowed: boolean): Promise<void> {
    if (this.purchaseChanging || allowed === this.finalPurchaseAllowed) return;
    this.purchaseChanging = true;
    this.actionMessage = "";
    try {
      const result = await this.electron.setFinalPurchaseAllowed(allowed);
      if (!result?.success) {
        this.actionMessage = result?.error || "Globale Kauf-Freigabe wurde vom Backend abgelehnt.";
      } else {
        this.actionMessage = result.allowFinalPurchase
          ? "Finaler Kauf global freigegeben. Backend-Guard bleibt bis unmittelbar vor Submit aktiv."
          : "Finaler Kauf global gesperrt. Alle Checkout-Tasks stoppen vor dem Submit.";
      }
      await this.refreshRuntime();
    } finally {
      this.purchaseChanging = false;
    }
  }

  async pauseTask(taskId: string): Promise<void> {
    const result = await this.electron.pauseTask(taskId);
    this.actionMessage = result.success
      ? "Queue-Task pausiert. Browser-Kontext wird kontrolliert beendet."
      : result.error || "Task konnte nicht pausiert werden.";
  }

  async stopTask(taskId: string): Promise<void> {
    const result = await this.electron.stopTask(taskId);
    this.actionMessage = result.success
      ? "Queue-Task gestoppt."
      : result.error || "Task konnte nicht gestoppt werden.";
  }

  private isEarlyGateChild(task: any): boolean {
    const trigger = task?.config?.data?.triggerSource;
    return trigger?.kind === "early-gate" && Boolean(trigger?.parentTaskId);
  }

  private get currentSystem(): any {
    return this.runtimeSystem ?? this.system ?? {};
  }

  private async refreshRuntime(): Promise<void> {
    const result = await this.electron.getSystemStatus();
    if (result?.success) this.runtimeSystem = result;
  }

  private formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "–";
    const totalSeconds = Math.floor(ms / 1_000);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
}
