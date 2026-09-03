import type { Page, Response } from "patchright";
import type { Task } from "../models";

export type QueuePhase = "waiting" | "released" | "timed-out";
export type QueueSignalSource = "dom" | "network" | "url" | "combined";

export interface QueueRuntimeStatus {
  active: boolean;
  phase: QueuePhase;
  position?: number;
  timeToWaitSeconds?: number;
  statusText?: string;
  source: QueueSignalSource;
  detectedAt: string;
  updatedAt: string;
  releasedAt?: string;
  elapsedMs: number;
  maxWaitMs: number;
}

interface QueueSignal {
  active: boolean;
  position?: number;
  timeToWaitSeconds?: number;
  statusText?: string;
  source: QueueSignalSource;
}

interface NetworkQueueSignal {
  position?: number;
  timeToWaitSeconds?: number;
  statusText?: string;
  updatedAt: number;
}

export interface QueueWaitOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
  releaseConfirmations?: number;
}

export interface QueueWaitResult {
  detected: boolean;
  released: boolean;
  elapsedMs: number;
}

const ONE_HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_POLL_MS = 2_000;
const NETWORK_SIGNAL_TTL_MS = 15_000;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[^0-9.,-]/g, "").replace(",", ".");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queueLikeUrl(url: string): boolean {
  return /(queue|waiting[-_]?room|queue-?it|incapsula_resource)/i.test(url);
}

function extractQueuePayload(value: unknown): { position?: number; timeToWaitSeconds?: number; statusText?: string } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const data = record["data"] && typeof record["data"] === "object"
    ? record["data"] as Record<string, unknown>
    : undefined;

  const position = numericValue(record["pos"] ?? record["position"] ?? data?.["pos"] ?? data?.["position"]);
  const timeToWaitSeconds = numericValue(record["ttw"] ?? record["timeToWait"] ?? data?.["ttw"] ?? data?.["timeToWait"]);
  const rawStatus = record["status"] ?? data?.["status"];
  const statusText = typeof rawStatus === "string" ? rawStatus.trim() : undefined;
  return { position, timeToWaitSeconds, statusText };
}

type PageResponseEvents = {
  on?: (event: "response", listener: (response: Response) => void) => unknown;
  off?: (event: "response", listener: (response: Response) => void) => unknown;
};

export class ShopifyQueueWaiter {
  private networkSignal?: NetworkQueueSignal;
  private responseListener?: (response: Response) => void;

  constructor(
    private readonly page: Page,
    private readonly task: Task,
    private readonly onTaskUpdate: (task: Task) => void = () => undefined,
    private readonly options: QueueWaitOptions = {}
  ) {}

  start(): void {
    if (this.responseListener) return;
    const events = this.page as unknown as PageResponseEvents;
    if (typeof events.on !== "function") return;

    this.responseListener = response => void this.captureResponse(response);
    events.on("response", this.responseListener);
  }

  stop(): void {
    if (!this.responseListener) return;
    const listener = this.responseListener;
    this.responseListener = undefined;

    const events = this.page as unknown as PageResponseEvents;
    if (typeof events.off === "function") events.off("response", listener);
  }

  async waitIfQueued(): Promise<QueueWaitResult> {
    const maxWaitMs = clampNumber(this.options.maxWaitMs ?? ONE_HOUR_MS, 1_000, ONE_HOUR_MS);
    const pollIntervalMs = clampNumber(this.options.pollIntervalMs ?? DEFAULT_POLL_MS, 250, 10_000);
    const releaseConfirmations = Math.max(1, Math.floor(this.options.releaseConfirmations ?? 2));
    const initial = await this.readSignal();

    if (!initial.active) {
      return { detected: false, released: false, elapsedMs: 0 };
    }

    const startedAt = Date.now();
    const detectedAt = new Date(startedAt).toISOString();
    let clearCount = 0;
    let lastSignal = initial;

    while (Date.now() - startedAt < maxWaitMs) {
      const elapsedMs = Date.now() - startedAt;
      const signal = await this.readSignal();
      if (signal.active) {
        clearCount = 0;
        lastSignal = signal;
        this.publish({
          active: true,
          phase: "waiting",
          position: signal.position,
          timeToWaitSeconds: signal.timeToWaitSeconds,
          statusText: signal.statusText,
          source: signal.source,
          detectedAt,
          updatedAt: new Date().toISOString(),
          elapsedMs,
          maxWaitMs
        });
      } else {
        clearCount += 1;
        if (clearCount >= releaseConfirmations) {
          const releasedAt = new Date().toISOString();
          this.publish({
            active: false,
            phase: "released",
            position: lastSignal.position,
            timeToWaitSeconds: 0,
            statusText: "Warteschlange verlassen",
            source: lastSignal.source,
            detectedAt,
            updatedAt: releasedAt,
            releasedAt,
            elapsedMs,
            maxWaitMs
          });
          return { detected: true, released: true, elapsedMs };
        }
      }

      await this.sleep(pollIntervalMs);
    }

    const elapsedMs = Date.now() - startedAt;
    this.publish({
      active: false,
      phase: "timed-out",
      position: lastSignal.position,
      timeToWaitSeconds: lastSignal.timeToWaitSeconds,
      statusText: "Maximale Queue-Wartezeit erreicht",
      source: lastSignal.source,
      detectedAt,
      updatedAt: new Date().toISOString(),
      elapsedMs,
      maxWaitMs
    });
    throw new Error(`Queue-Wartezeit von ${Math.round(maxWaitMs / 60_000)} Minuten überschritten.`);
  }

  private publish(queueStatus: QueueRuntimeStatus): void {
    this.task.config.data = {
      ...(this.task.config.data ?? {}),
      queueStatus
    };
    this.onTaskUpdate(this.task);
  }

  private async readSignal(): Promise<QueueSignal> {
    if (this.page.isClosed()) return { active: false, source: "dom" };

    const dom = await this.page.evaluate(() => {
      const queuePosition = document.getElementById("queue-position");
      const position = queuePosition ?? document.getElementById("position");
      const status = document.getElementById("status");
      return {
        hasQueuePosition: Boolean(queuePosition),
        hasPosition: Boolean(position),
        positionText: position?.textContent?.trim() ?? "",
        statusText: status?.textContent?.trim() ?? "",
        url: location.href
      };
    }).catch(() => ({
      hasQueuePosition: false,
      hasPosition: false,
      positionText: "",
      statusText: "",
      url: this.page.url()
    }));

    const recentNetwork = this.networkSignal && Date.now() - this.networkSignal.updatedAt <= NETWORK_SIGNAL_TTL_MS
      ? this.networkSignal
      : undefined;
    const domPosition = numericValue(dom.positionText);
    const urlSignal = queueLikeUrl(dom.url);
    const statusLooksQueued = /(queue|warteschlange|waiting|position|wait)/i.test(dom.statusText);
    const domActive = dom.hasQueuePosition || (dom.hasPosition && (statusLooksQueued || urlSignal));
    const networkActive = Boolean(recentNetwork && (
      recentNetwork.position !== undefined || recentNetwork.timeToWaitSeconds !== undefined
    ));
    const active = domActive || networkActive || urlSignal;

    const source: QueueSignalSource = [domActive, networkActive, urlSignal].filter(Boolean).length > 1
      ? "combined"
      : domActive ? "dom"
      : networkActive ? "network"
      : "url";

    return {
      active,
      position: recentNetwork?.position ?? domPosition,
      timeToWaitSeconds: recentNetwork?.timeToWaitSeconds,
      statusText: recentNetwork?.statusText || dom.statusText || undefined,
      source
    };
  }

  private async captureResponse(response: Response): Promise<void> {
    const url = response.url();
    if (!queueLikeUrl(url)) return;

    try {
      const contentType = response.headers()["content-type"] ?? "";
      if (!/(json|javascript|text)/i.test(contentType)) return;
      const text = await response.text();
      if (!text || text.length > 256_000) return;
      const payload = JSON.parse(text) as unknown;
      const extracted = extractQueuePayload(payload);
      if (extracted.position === undefined && extracted.timeToWaitSeconds === undefined) return;
      this.networkSignal = {
        ...extracted,
        updatedAt: Date.now()
      };
    } catch {
      // Queue traffic is best-effort telemetry; DOM detection remains available.
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
