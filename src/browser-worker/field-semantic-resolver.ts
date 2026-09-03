import * as http from "http";
import * as https from "https";
import type { Locator, Page } from "patchright";

export type FieldIntent =
  | "email"
  | "firstName"
  | "lastName"
  | "address1"
  | "address2"
  | "city"
  | "postalCode"
  | "phone"
  | "countryCode"
  | "unknown";

export interface FieldDescriptor {
  index: number;
  tagName: string;
  inputType: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  nearbyText: string;
}

export interface ResolvedField {
  descriptor: FieldDescriptor;
  intent: FieldIntent;
  confidence: number;
  source: "standard-metadata" | "embedding" | "unknown";
}

export interface SemanticEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

const CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="password"])',
  "select",
  "textarea"
].join(", ");

const INTENT_PROTOTYPES: Array<{ intent: Exclude<FieldIntent, "unknown">; text: string }> = [
  { intent: "email", text: "email address" },
  { intent: "email", text: "E-Mail-Adresse" },
  { intent: "email", text: "Kontakt E-Mail für Bestellbestätigung" },

  { intent: "firstName", text: "first name" },
  { intent: "firstName", text: "given name" },
  { intent: "firstName", text: "Vorname" },
  { intent: "firstName", text: "Vorname der empfangenden Person" },

  { intent: "lastName", text: "last name" },
  { intent: "lastName", text: "family name" },
  { intent: "lastName", text: "surname" },
  { intent: "lastName", text: "Nachname" },
  { intent: "lastName", text: "Familienname" },
  { intent: "lastName", text: "Nachname der empfangenden Person" },

  { intent: "address1", text: "street address" },
  { intent: "address1", text: "Straße und Hausnummer" },
  { intent: "address1", text: "primary delivery address" },

  { intent: "address2", text: "address line 2" },
  { intent: "address2", text: "apartment or company address addition" },
  { intent: "address2", text: "Adresszusatz" },

  { intent: "city", text: "city" },
  { intent: "city", text: "town or locality" },
  { intent: "city", text: "Ort oder Stadt" },
  { intent: "city", text: "Gemeinde der Lieferanschrift" },

  { intent: "postalCode", text: "postal code" },
  { intent: "postalCode", text: "ZIP code" },
  { intent: "postalCode", text: "Postleitzahl" },
  { intent: "postalCode", text: "Zustellcode für das Postgebiet" },

  { intent: "phone", text: "phone number" },
  { intent: "phone", text: "mobile number" },
  { intent: "phone", text: "Telefonnummer oder Rufnummer" },

  { intent: "countryCode", text: "country" },
  { intent: "countryCode", text: "delivery country" },
  { intent: "countryCode", text: "Land der Lieferadresse" }
];

const AUTOCOMPLETE_INTENTS: Record<string, Exclude<FieldIntent, "unknown">> = {
  "email": "email",
  "given-name": "firstName",
  "family-name": "lastName",
  "address-line1": "address1",
  "address-line2": "address2",
  "address-level2": "city",
  "postal-code": "postalCode",
  "tel": "phone",
  "country": "countryCode",
  "country-name": "countryCode"
};

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (!length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function semanticIdentifier(value: string): string {
  const normalized = normalize(value.replace(/[_-]+/g, " "));
  if (!normalized) return "";
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]{3,}/.test(normalized)) return "";
  if (/^(?:field|input|control|form)\s*\d*$/i.test(normalized)) return "";
  return normalized;
}

function postJson<T>(endpoint: string, payload: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(endpoint);
    } catch {
      reject(new Error("Invalid local embedding endpoint."));
      return;
    }

    if (target.protocol !== "http:" && target.protocol !== "https:") {
      reject(new Error(`Unsupported local embedding protocol: ${target.protocol}`));
      return;
    }

    const body = JSON.stringify(payload);
    const client = target.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      callback();
    };

    const request = client.request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    }, response => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { responseBody += chunk; });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finish(() => reject(new Error(`Ollama embed HTTP ${status}`)));
          return;
        }
        try {
          const parsed = JSON.parse(responseBody) as T;
          finish(() => resolve(parsed));
        } catch {
          finish(() => reject(new Error("Local embedding response was not valid JSON."));
        }
      });
    });

    request.on("error", error => finish(() => reject(error)));
    const hardTimeout = setTimeout(() => {
      request.destroy(new Error("Local embedding request timed out."));
    }, Math.max(200, timeoutMs));

    request.write(body);
    request.end();
  });
}

export class OllamaEmbeddingProvider implements SemanticEmbeddingProvider {
  private disabledUntil = 0;
  private warmed = false;

  constructor(
    private readonly endpoint: string = process.env["ARES_FIELD_EMBED_ENDPOINT"]?.trim() || "http://127.0.0.1:11434/api/embed",
    private readonly model: string = process.env["ARES_FIELD_EMBED_MODEL"]?.trim() || "embeddinggemma:300m-qat-q4_0",
    private readonly timeoutMs: number = Number(process.env["ARES_FIELD_EMBED_TIMEOUT_MS"] || 1_200),
    private readonly coldStartTimeoutMs: number = Number(process.env["ARES_FIELD_EMBED_COLD_TIMEOUT_MS"] || 3_500)
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (Date.now() < this.disabledUntil) {
      throw new Error("Local semantic embedding runtime is temporarily unavailable.");
    }

    try {
      const requestTimeoutMs = this.warmed
        ? this.timeoutMs
        : Math.max(this.timeoutMs, this.coldStartTimeoutMs);
      const payload = await postJson<OllamaEmbedResponse>(this.endpoint, {
        model: this.model,
        input: texts
      }, requestTimeoutMs);
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
        throw new Error("Ollama embed response did not contain the expected embedding batch.");
      }
      this.warmed = true;
      return payload.embeddings;
    } catch (error) {
      this.disabledUntil = Date.now() + 30_000;
      throw error;
    }
  }
}

export class FieldSemanticResolver {
  private prototypeVectors: Array<{ intent: Exclude<FieldIntent, "unknown">; vector: number[] }> | undefined;
  private readonly cache = new Map<string, { intent: FieldIntent; confidence: number; source: ResolvedField["source"] }>();

  constructor(private readonly provider: SemanticEmbeddingProvider = new OllamaEmbeddingProvider()) {}

  async resolve(fields: FieldDescriptor[]): Promise<ResolvedField[]> {
    const results: Array<ResolvedField | undefined> = new Array(fields.length);
    const unresolved: Array<{ field: FieldDescriptor; position: number; key: string }> = [];

    fields.forEach((field, position) => {
      const standard = this.resolveFromStandardMetadata(field);
      if (standard) {
        results[position] = { descriptor: field, ...standard };
        return;
      }

      const key = this.cacheKey(field);
      const cached = this.cache.get(key);
      if (cached) {
        results[position] = { descriptor: field, ...cached };
        return;
      }
      unresolved.push({ field, position, key });
    });

    if (unresolved.length) {
      try {
        await this.resolveByEmbedding(unresolved, results);
      } catch {
        for (const item of unresolved) {
          const fallback = { intent: "unknown" as FieldIntent, confidence: 0, source: "unknown" as const };
          this.cache.set(item.key, fallback);
          results[item.position] = { descriptor: item.field, ...fallback };
        }
      }
    }

    return results.map((result, index) => result ?? {
      descriptor: fields[index]!,
      intent: "unknown",
      confidence: 0,
      source: "unknown"
    });
  }

  private resolveFromStandardMetadata(field: FieldDescriptor): Omit<ResolvedField, "descriptor"> | undefined {
    const tokens = field.autocomplete.toLowerCase().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const intent = AUTOCOMPLETE_INTENTS[token];
      if (intent) return { intent, confidence: 1, source: "standard-metadata" };
    }
    if (field.inputType.toLowerCase() === "email") {
      return { intent: "email", confidence: 0.99, source: "standard-metadata" };
    }
    if (field.inputType.toLowerCase() === "tel") {
      return { intent: "phone", confidence: 0.99, source: "standard-metadata" };
    }
    return undefined;
  }

  private async resolveByEmbedding(
    unresolved: Array<{ field: FieldDescriptor; position: number; key: string }>,
    results: Array<ResolvedField | undefined>
  ): Promise<void> {
    const fieldTexts = unresolved.map(item => this.toSemanticText(item.field));
    let fieldVectors: number[][];

    if (!this.prototypeVectors) {
      const prototypeTexts = INTENT_PROTOTYPES.map(item => item.text);
      const allVectors = await this.provider.embed([...prototypeTexts, ...fieldTexts]);
      this.prototypeVectors = INTENT_PROTOTYPES.map((item, index) => ({
        intent: item.intent,
        vector: allVectors[index] ?? []
      }));
      fieldVectors = allVectors.slice(prototypeTexts.length);
    } else {
      fieldVectors = await this.provider.embed(fieldTexts);
    }

    unresolved.forEach((item, unresolvedIndex) => {
      const vector = fieldVectors[unresolvedIndex] ?? [];
      const scoresByIntent = new Map<Exclude<FieldIntent, "unknown">, number[]>();
      for (const prototype of this.prototypeVectors ?? []) {
        const score = cosine(vector, prototype.vector);
        const scores = scoresByIntent.get(prototype.intent) ?? [];
        scores.push(score);
        scoresByIntent.set(prototype.intent, scores);
      }

      const ranking = Array.from(scoresByIntent.entries())
        .map(([intent, scores]) => {
          const ordered = [...scores].sort((left, right) => right - left);
          const bestScore = ordered[0] ?? -1;
          const secondScore = ordered[1] ?? bestScore;
          return {
            intent,
            score: bestScore * 0.8 + secondScore * 0.2
          };
        })
        .sort((left, right) => right.score - left.score);

      const best = ranking[0];
      const second = ranking[1];
      const margin = best ? best.score - (second?.score ?? -1) : 0;
      const accepted = Boolean(best && best.score >= 0.35 && margin >= 0.015);
      const resolution = accepted && best
        ? {
            intent: best.intent as FieldIntent,
            confidence: clamp(0.5 + Math.max(0, best.score - 0.35) * 0.65 + margin * 2.5, 0.5, 0.99),
            source: "embedding" as const
          }
        : {
            intent: "unknown" as FieldIntent,
            confidence: 0,
            source: "unknown" as const
          };

      this.cache.set(item.key, resolution);
      results[item.position] = { descriptor: item.field, ...resolution };
    });
  }

  private toSemanticText(field: FieldDescriptor): string {
    const name = semanticIdentifier(field.name);
    const id = semanticIdentifier(field.id);
    const parts = [
      normalize(field.label) ? `label: ${normalize(field.label)}` : "",
      normalize(field.ariaLabel) ? `aria label: ${normalize(field.ariaLabel)}` : "",
      normalize(field.placeholder) ? `placeholder: ${normalize(field.placeholder)}` : "",
      name ? `name: ${name}` : "",
      id ? `id: ${id}` : "",
      normalize(field.nearbyText) ? `context: ${normalize(field.nearbyText)}` : ""
    ].filter(Boolean);

    if (!parts.length) {
      parts.push(`form control: ${normalize(`${field.tagName} ${field.inputType}`)}`);
    }
    return parts.join(" | ");
  }

  private cacheKey(field: FieldDescriptor): string {
    return this.toSemanticText(field).toLowerCase();
  }
}

export async function collectFieldDescriptors(page: Page): Promise<FieldDescriptor[]> {
  return page.locator(CONTROL_SELECTOR).evaluateAll(elements => elements.map((raw, index) => {
    const element = raw as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const labels = "labels" in element && element.labels
      ? Array.from(element.labels).map(label => label.textContent || "").join(" ")
      : "";
    const labelledBy = element.getAttribute("aria-labelledby") || "";
    const ariaText = labelledBy.split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || "").join(" ");
    const closestLabel = element.closest("label")?.textContent || "";
    const parentText = element.parentElement?.innerText || "";
    return {
      index,
      tagName: element.tagName.toLowerCase(),
      inputType: element instanceof HTMLInputElement ? (element.type || "text") : element.tagName.toLowerCase(),
      name: element.getAttribute("name") || "",
      id: element.id || "",
      autocomplete: element.getAttribute("autocomplete") || "",
      placeholder: element.getAttribute("placeholder") || "",
      ariaLabel: [element.getAttribute("aria-label") || "", ariaText].join(" ").trim(),
      label: [labels, closestLabel].join(" ").trim(),
      nearbyText: parentText.replace(/\s+/g, " ").trim().slice(0, 240)
    };
  }));
}

export function fieldLocator(page: Page, index: number): Locator {
  return page.locator(CONTROL_SELECTOR).nth(index);
}
