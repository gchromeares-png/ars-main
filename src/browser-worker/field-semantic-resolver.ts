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
  { intent: "email", text: "contact email address, E-Mail-Adresse für Kontakt und Bestellbestätigung" },
  { intent: "firstName", text: "person's given name, first name, Vorname der empfangenden Person" },
  { intent: "lastName", text: "person's family name, surname, Nachname oder Familienname der empfangenden Person" },
  { intent: "address1", text: "primary street delivery address, Straße und Hausnummer der Lieferadresse" },
  { intent: "address2", text: "secondary address line, apartment, company, Zusatz zur Anschrift, Adresszusatz" },
  { intent: "city", text: "delivery city, town or locality, Ort oder Stadt der Lieferadresse" },
  { intent: "postalCode", text: "postal code, ZIP code, Postleitzahl der Lieferadresse" },
  { intent: "phone", text: "contact phone or mobile number, Telefonnummer oder Mobilnummer" },
  { intent: "countryCode", text: "delivery country or country code, Land der Lieferadresse" }
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

export class OllamaEmbeddingProvider implements SemanticEmbeddingProvider {
  private disabledUntil = 0;

  constructor(
    private readonly endpoint: string = process.env["ARES_FIELD_EMBED_ENDPOINT"]?.trim() || "http://127.0.0.1:11434/api/embed",
    private readonly model: string = process.env["ARES_FIELD_EMBED_MODEL"]?.trim() || "embeddinggemma:300m-qat-q4_0",
    private readonly timeoutMs: number = Number(process.env["ARES_FIELD_EMBED_TIMEOUT_MS"] || 1_200)
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (Date.now() < this.disabledUntil) {
      throw new Error("Local semantic embedding runtime is temporarily unavailable.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(200, this.timeoutMs));
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Ollama embed HTTP ${response.status}`);
      }
      const payload = await response.json() as OllamaEmbedResponse;
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
        throw new Error("Ollama embed response did not contain the expected embedding batch.");
      }
      return payload.embeddings;
    } catch (error) {
      this.disabledUntil = Date.now() + 30_000;
      throw error;
    } finally {
      clearTimeout(timeout);
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
      const ranking = (this.prototypeVectors ?? [])
        .map(prototype => ({ intent: prototype.intent, score: cosine(vector, prototype.vector) }))
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
    return [
      `form control type: ${field.tagName} ${field.inputType}`,
      `label: ${field.label}`,
      `aria label: ${field.ariaLabel}`,
      `placeholder: ${field.placeholder}`,
      `name: ${field.name}`,
      `id: ${field.id}`,
      `autocomplete: ${field.autocomplete}`,
      `surrounding form text: ${field.nearbyText}`
    ].map(normalize).filter(Boolean).join(" | ");
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
