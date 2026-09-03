import type { Frame, Page } from "patchright";

export type WaitingRoomState = "clear" | "waiting" | "released" | "timed-out" | "cancelled";

export interface WaitingRoomDetection {
  inQueue: boolean;
  provider?: "incapsula" | "generic";
  estimatedWaitSeconds?: number;
  evidence: string[];
}

export interface WaitingRoomStatus extends WaitingRoomDetection {
  state: WaitingRoomState;
  detectedAt?: string;
  updatedAt: string;
  elapsedMs: number;
  maxWaitMs: number;
}

export interface WaitingRoomResult {
  waited: boolean;
  state: WaitingRoomState;
  detection: WaitingRoomDetection;
  elapsedMs: number;
}

export interface WaitingRoomWaitOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
  statusIntervalMs?: number;
  onStatus?: (status: WaitingRoomStatus) => void;
}

const DEFAULT_MAX_WAIT_MS = 60 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STATUS_INTERVAL_MS = 15_000;
const QUEUE_TEXT_PATTERN = /\b(queue|waiting\s*room|estimated\s+wait|wait\s+time|warte(?:zeit|raum)?|warteschlange)\b/i;
const QUEUE_URL_PATTERN = /\/(?:queue|waiting-room|waiting_room|throttle)(?:[/?#]|$)/i;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseWaitingRoomTime(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || minutes > 59 || seconds > 59) return undefined;
  return hours * 3600 + minutes * 60 + seconds;
}

async function readText(locator: { textContent(options?: { timeout?: number }): Promise<string | null> }): Promise<string | undefined> {
  try {
    const text = await locator.textContent({ timeout: 250 });
    return text?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function frameQueueEvidence(frame: Frame): Promise<{ ttw?: string; queueText: boolean }> {
  const ttw = await readText(frame.locator("#ttw").first());
  if (ttw) return { ttw, queueText: true };

  try {
    const text = await frame.locator("body").first().textContent({ timeout: 250 });
    return { queueText: QUEUE_TEXT_PATTERN.test(text || "") };
  } catch {
    return { queueText: false };
  }
}

export class IncapsulaWaitingRoom {
  async detect(page: Page): Promise<WaitingRoomDetection> {
    if (page.isClosed()) return { inQueue: false, evidence: ["page-closed"] };

    const evidence: string[] = [];
    let estimatedWaitSeconds: number | undefined;
    let queueTextDetected = false;
    let incapsulaDetected = false;

    if (QUEUE_URL_PATTERN.test(page.url())) evidence.push("queue-like-url");

    const mainTtw = await readText(page.locator("#ttw").first());
    if (mainTtw) {
      estimatedWaitSeconds = parseWaitingRoomTime(mainTtw);
      evidence.push("ttw");
      queueTextDetected = true;
    }

    try {
      const iframeCount = await page.locator('iframe[src*="/_Incapsula_Resource"]').count();
      if (iframeCount > 0) {
        incapsulaDetected = true;
        evidence.push("incapsula-iframe");
      }
    } catch {
      // DOM can change during auto-forward. Frame inspection below is the fallback.
    }

    for (const frame of page.frames()) {
      const frameUrl = frame.url();
      const isIncapsulaFrame = frameUrl.includes("/_Incapsula_Resource");
      if (isIncapsulaFrame) {
        incapsulaDetected = true;
        if (!evidence.includes("incapsula-frame-url")) evidence.push("incapsula-frame-url");
      }

      const frameEvidence = await frameQueueEvidence(frame);
      if (frameEvidence.ttw && estimatedWaitSeconds === undefined) {
        estimatedWaitSeconds = parseWaitingRoomTime(frameEvidence.ttw);
        evidence.push("frame-ttw");
      }
      if (frameEvidence.queueText) queueTextDetected = true;
    }

    try {
      const cookies = await page.context().cookies();
      if (cookies.some(cookie => cookie.name.startsWith("incap_ses_"))) {
        incapsulaDetected = true;
        evidence.push("incap-session-cookie");
      }
    } catch {
      // Cookie access is diagnostic only and must never decide queue state on its own.
    }

    const queueLikeUrl = evidence.includes("queue-like-url");
    const hasConcreteWaitTime = estimatedWaitSeconds !== undefined;
    const inQueue = hasConcreteWaitTime || queueLikeUrl || (incapsulaDetected && queueTextDetected);

    return {
      inQueue,
      provider: inQueue ? (incapsulaDetected ? "incapsula" : "generic") : undefined,
      estimatedWaitSeconds,
      evidence
    };
  }

  async waitIfNeeded(page: Page, options: WaitingRoomWaitOptions = {}): Promise<WaitingRoomResult> {
    const maxWaitMs = Math.min(DEFAULT_MAX_WAIT_MS, Math.max(1_000, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS));
    const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const statusIntervalMs = Math.max(pollIntervalMs, options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS);

    const initial = await this.detect(page);
    if (!initial.inQueue) {
      return { waited: false, state: "clear", detection: initial, elapsedMs: 0 };
    }

    const startedAt = Date.now();
    const detectedAt = new Date(startedAt).toISOString();
    let lastDetection = initial;
    let lastStatusAt = 0;
    let lastEstimatedWaitSeconds = initial.estimatedWaitSeconds;

    const emit = (state: WaitingRoomState, detection: WaitingRoomDetection): void => {
      const now = Date.now();
      options.onStatus?.({
        ...detection,
        state,
        detectedAt,
        updatedAt: new Date(now).toISOString(),
        elapsedMs: now - startedAt,
        maxWaitMs
      });
      lastStatusAt = now;
      lastEstimatedWaitSeconds = detection.estimatedWaitSeconds;
    };

    emit("waiting", initial);

    while (true) {
      if (page.isClosed()) {
        const elapsedMs = Date.now() - startedAt;
        const detection = { inQueue: false, evidence: ["page-closed"] } as WaitingRoomDetection;
        emit("cancelled", detection);
        return { waited: true, state: "cancelled", detection, elapsedMs };
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) {
        emit("timed-out", lastDetection);
        return { waited: true, state: "timed-out", detection: lastDetection, elapsedMs };
      }

      await sleep(Math.min(pollIntervalMs, Math.max(1, maxWaitMs - elapsedMs)));
      lastDetection = await this.detect(page);

      if (!lastDetection.inQueue) {
        const releasedElapsedMs = Date.now() - startedAt;
        emit("released", lastDetection);
        return { waited: true, state: "released", detection: lastDetection, elapsedMs: releasedElapsedMs };
      }

      const estimateChanged = lastDetection.estimatedWaitSeconds !== lastEstimatedWaitSeconds;
      if (estimateChanged || Date.now() - lastStatusAt >= statusIntervalMs) {
        emit("waiting", lastDetection);
      }
    }
  }
}
