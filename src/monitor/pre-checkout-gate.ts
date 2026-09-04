import * as http from "http";
import * as https from "https";
import type { CommerceShop } from "../commerce/platforms";
import type { Task } from "../models";
import { getMonitorStrategy, type PreCheckoutGateEvent } from "./early-gate";

export interface PreCheckoutGate {
  evaluate(task: Task, shop: CommerceShop, signal?: AbortSignal): Promise<PreCheckoutGateEvent | undefined>;
}

export interface PassiveHttpGateOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
}

interface PassiveProbeResult {
  url: string;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_BODY_BYTES = 256_000;

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const parsed = Number(text.replace(/[^0-9.,-]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function telemetryFromText(url: string, body: string): { position?: number; timeToWaitSeconds?: number } {
  let position: number | undefined;
  let timeToWaitSeconds: number | undefined;
  try {
    const parsed = new URL(url);
    position = numberFrom(parsed.searchParams.get("pos") ?? parsed.searchParams.get("position"));
    timeToWaitSeconds = numberFrom(parsed.searchParams.get("ttw") ?? parsed.searchParams.get("timeToWait"));
  } catch {}

  if (position === undefined) {
    const match = body.match(/["']?(?:pos|position)["']?\s*[:=]\s*["']?([0-9.,-]+)/i);
    position = numberFrom(match?.[1]);
  }
  if (timeToWaitSeconds === undefined) {
    const match = body.match(/["']?(?:ttw|timeToWait)["']?\s*[:=]\s*["']?([0-9.,-]+)/i);
    timeToWaitSeconds = numberFrom(match?.[1]);
  }
  return { position, timeToWaitSeconds };
}

function configuredSignals(shop: CommerceShop): string[] {
  const raw = shop.config?.["earlyGateSignals"];
  return Array.isArray(raw)
    ? raw.map(value => String(value).trim()).filter(Boolean).slice(0, 24)
    : [];
}

function signalKind(result: PassiveProbeResult, shop: CommerceShop): { type: PreCheckoutGateEvent["type"]; source: string } | undefined {
  const material = `${result.url}\n${String(result.headers.location ?? "")}\n${result.body}`;
  if (/incapsula_resource/i.test(material)) return { type: "queue-signal", source: "incapsula-resource" };
  if (/(waiting[-_ ]?room|queue-?it|warteschlange|queue position|queue-position)/i.test(material)) {
    return { type: "queue-signal", source: "passive-http" };
  }
  for (const marker of configuredSignals(shop)) {
    if (material.toLocaleLowerCase("en-US").includes(marker.toLocaleLowerCase("en-US"))) {
      return { type: "early-drop-signal", source: `configured:${marker.slice(0, 48)}` };
    }
  }
  return undefined;
}

export class PassiveHttpPreCheckoutGate implements PreCheckoutGate {
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxRedirects: number;

  constructor(options: PassiveHttpGateOptions = {}) {
    this.timeoutMs = Math.min(15_000, Math.max(500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxBodyBytes = Math.min(512_000, Math.max(8_192, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES));
    this.maxRedirects = Math.min(3, Math.max(0, options.maxRedirects ?? 2));
  }

  async evaluate(task: Task, shop: CommerceShop, signal?: AbortSignal): Promise<PreCheckoutGateEvent | undefined> {
    const strategy = getMonitorStrategy(task);
    if (strategy.mode !== "early-gate") return undefined;
    if (signal?.aborted) return undefined;

    const result = await this.probe(shop.baseUrl, signal, this.maxRedirects);
    const detected = signalKind(result, shop);
    if (!detected) return undefined;
    const telemetry = telemetryFromText(result.url, result.body);
    return {
      type: detected.type,
      shopId: shop.id,
      observedAt: new Date(),
      source: detected.source,
      position: telemetry.position,
      timeToWaitSeconds: telemetry.timeToWaitSeconds,
      statusText: detected.type === "queue-signal" ? "Passives Queue-/Gate-Signal erkannt" : "Frühes Drop-Signal erkannt"
    };
  }

  private probe(url: string, signal: AbortSignal | undefined, redirectsLeft: number): Promise<PassiveProbeResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: unknown, result?: PassiveProbeResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const onAbort = () => {
        request.destroy();
        done(new Error("Gate-Probe abgebrochen."));
      };

      let parsed: URL;
      try {
        parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      } catch (error) {
        done(error);
        return;
      }
      const transport = parsed.protocol === "http:" ? http : https;
      const request = transport.request(parsed, {
        method: "GET",
        headers: {
          "accept": "text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "user-agent": "ARES-Monitor/1.0"
        }
      }, response => {
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;
        if (location && redirectsLeft > 0 && statusCode >= 300 && statusCode < 400) {
          response.resume();
          let next: string;
          try { next = new URL(location, parsed).toString(); }
          catch (error) { done(error); return; }
          void this.probe(next, signal, redirectsLeft - 1).then(value => done(undefined, value), done);
          return;
        }

        response.setEncoding("utf8");
        let body = "";
        response.on("data", chunk => {
          if (body.length >= this.maxBodyBytes) return;
          body += String(chunk).slice(0, this.maxBodyBytes - body.length);
        });
        response.on("end", () => done(undefined, {
          url: parsed.toString(),
          statusCode,
          headers: response.headers,
          body
        }));
        response.on("error", done);
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error("Gate-Probe Timeout.")));
      request.on("error", done);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      request.end();
    });
  }
}
