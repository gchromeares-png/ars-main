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

type KnownFieldIntent = Exclude<FieldIntent, "unknown">;
type PrototypeTier = 1 | 2 | 3;

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

interface IntentPrototype {
  intent: KnownFieldIntent;
  text: string;
  tier: PrototypeTier;
}

interface IntentScore {
  intent: KnownFieldIntent;
  score: number;
}

interface LexicalRule {
  intent: KnownFieldIntent;
  terms: string[];
}

const CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="password"])',
  "select",
  "textarea"
].join(", ");

// Tier 1 contains the strongest, most common German checkout labels.
// Tier 2 adds common German/English synonyms. Tier 3 adds contextual phrases.
// All prototype embeddings are batched once, but scoring expands tier by tier only when needed.
const INTENT_PROTOTYPES: IntentPrototype[] = [
  { intent: "email", text: "E-Mail-Adresse", tier: 1 },
  { intent: "firstName", text: "Vorname", tier: 1 },
  { intent: "lastName", text: "Nachname", tier: 1 },
  { intent: "address1", text: "Straße und Hausnummer", tier: 1 },
  { intent: "address2", text: "Adresszusatz", tier: 1 },
  { intent: "city", text: "Ort", tier: 1 },
  { intent: "postalCode", text: "Postleitzahl", tier: 1 },
  { intent: "phone", text: "Telefonnummer", tier: 1 },
  { intent: "countryCode", text: "Land", tier: 1 },

  { intent: "email", text: "E-Mail", tier: 2 },
  { intent: "email", text: "email address", tier: 2 },
  { intent: "firstName", text: "Vornamen", tier: 2 },
  { intent: "firstName", text: "Rufname", tier: 2 },
  { intent: "firstName", text: "first name", tier: 2 },
  { intent: "firstName", text: "given name", tier: 2 },
  { intent: "lastName", text: "Familienname", tier: 2 },
  { intent: "lastName", text: "surname", tier: 2 },
  { intent: "lastName", text: "family name", tier: 2 },
  { intent: "address1", text: "Straße", tier: 2 },
  { intent: "address1", text: "Lieferanschrift", tier: 2 },
  { intent: "address1", text: "street address", tier: 2 },
  { intent: "address2", text: "Adresszeile 2", tier: 2 },
  { intent: "address2", text: "address line 2", tier: 2 },
  { intent: "city", text: "Stadt", tier: 2 },
  { intent: "city", text: "Wohnort", tier: 2 },
  { intent: "city", text: "Gemeinde", tier: 2 },
  { intent: "city", text: "city", tier: 2 },
  { intent: "postalCode", text: "PLZ", tier: 2 },
  { intent: "postalCode", text: "postal code", tier: 2 },
  { intent: "postalCode", text: "ZIP code", tier: 2 },
  { intent: "phone", text: "Telefon", tier: 2 },
  { intent: "phone", text: "Mobilnummer", tier: 2 },
  { intent: "phone", text: "Handynummer", tier: 2 },
  { intent: "phone", text: "phone number", tier: 2 },
  { intent: "countryCode", text: "Lieferland", tier: 2 },
  { intent: "countryCode", text: "Land oder Region", tier: 2 },
  { intent: "countryCode", text: "country", tier: 2 },

  { intent: "email", text: "Kontakt E-Mail für Bestellbestätigung", tier: 3 },
  { intent: "firstName", text: "Vorname des Empfängers", tier: 3 },
  { intent: "firstName", text: "Vorname der empfangenden Person", tier: 3 },
  { intent: "firstName", text: "Vorname Rechnungsadresse", tier: 3 },
  { intent: "lastName", text: "Nachname des Empfängers", tier: 3 },
  { intent: "lastName", text: "Nachname der empfangenden Person", tier: 3 },
  { intent: "lastName", text: "Nachname Rechnungsadresse", tier: 3 },
  { intent: "address1", text: "Straße und Hausnummer der Lieferanschrift", tier: 3 },
  { intent: "address1", text: "primäre Lieferadresse", tier: 3 },
  { intent: "address2", text: "Wohnung Firma oder zusätzlicher Adresshinweis", tier: 3 },
  { intent: "city", text: "Ort oder Stadt der Lieferanschrift", tier: 3 },
  { intent: "city", text: "Gemeinde der Lieferanschrift", tier: 3 },
  { intent: "postalCode", text: "Postleitzahl des Zustellgebiets", tier: 3 },
  { intent: "phone", text: "Telefonnummer für Rückfragen", tier: 3 },
  { intent: "countryCode", text: "Land der Lieferadresse", tier: 3 }
];

const LEXICAL_RULES: LexicalRule[] = [
  { intent: "email", terms: ["e mail adresse", "email adresse", "e mail", "email"] },
  { intent: "firstName", terms: ["vorname", "vornamen", "rufname"] },
  { intent: "lastName", terms: ["nachname", "familienname"] },
  { intent: "address1", terms: ["strasse und hausnummer", "lieferanschrift", "strasse"] },
  { intent: "address2", terms: ["adresszusatz", "adresszeile 2", "address line 2"] },
  { intent: "city", terms: ["ort stadt", "wohnort", "gemeinde", "stadt", "ort"] },
  { intent: "postalCode", terms: ["postleitzahl", "plz"] },
  { intent: "phone", terms: ["telefonnummer", "mobilnummer", "handynummer", "telefon"] },
  { intent: "countryCode", terms: ["land region", "lieferland", "land"] }
];

const AUTOCOMPLETE_INTENTS: Record<string, KnownFieldIntent> = {
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

function normalizeForMatch(value: string): string {
  return normalize(value)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/e\s*[-_]?\s*mail/g, "email")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function containsTerm(text: string, term: string): boolean {
  const normalizedText = ` ${normalizeForMatch(text)} `;
  const normalizedTerm = normalizeForMatch(term);
  return Boolean(normalizedTerm && normalizedText.includes(` ${normalizedTerm} `));
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + substitutionCost
      );
    }
    for (let index = 0; index <= right.length; index++) {
      previous[index] = current[index]!;
    }
  }

  return previous[right.length]!;
}

function wordSimilarity(left: string, right: string): number {
  const a = normalizeForMatch(left);
  const b = normalizeForMatch(right);
  if (!a || !b) return 0;
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - levenshteinDistance(a, b) / longest : 0;
}

function bestFuzzyTokenSimilarity(text: string, term: string): number {
  const normalizedTerm = normalizeForMatch(term);
  if (!normalizedTerm || normalizedTerm.includes(" ")) return 0;
  const tokens = normalizeForMatch(text).split(" ").filter(token => token.length >= 3);
  let best = 0;
  for (const token of tokens) {
    if (Math.abs(token.length - normalizedTerm.length) > 2) continue;
    best = Math.max(best, wordSimilarity(token, normalizedTerm));
  }
  return best;
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
          finish(() => reject(new Error("Local embedding response was not valid JSON.")));
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
  private prototypeVectors: Array<IntentPrototype & { vector: number[] }> | undefined;
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

      const lexical = this.resolveFromLexicalMetadata(field);
      if (lexical) {
        results[position] = { descriptor: field, ...lexical };
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

  private resolveFromLexicalMetadata(field: FieldDescriptor): Omit<ResolvedField, "descriptor"> | undefined {
    const signals: Array<{ value: string; weight: number }> = [
      { value: field.label, weight: 1 },
      { value: field.ariaLabel, weight: 0.95 },
      { value: field.placeholder, weight: 0.82 },
      { value: semanticIdentifier(field.name), weight: 0.62 },
      { value: semanticIdentifier(field.id), weight: 0.52 },
      { value: field.nearbyText, weight: 0.34 }
    ].filter(signal => Boolean(normalize(signal.value)));

    const exactScores = new Map<KnownFieldIntent, number>();
    for (const signal of signals) {
      for (const rule of LEXICAL_RULES) {
        const matchedTerms = rule.terms.filter(term => containsTerm(signal.value, term));
        if (!matchedTerms.length) continue;
        const specificityBonus = Math.min(0.18, Math.max(...matchedTerms.map(term => normalizeForMatch(term).length)) / 100);
        const score = signal.weight + specificityBonus;
        exactScores.set(rule.intent, Math.max(exactScores.get(rule.intent) ?? 0, score));
      }
    }

    const exact = this.pickMetadataCandidate(exactScores, 0.8, 0.2);
    if (exact) {
      return { intent: exact.intent, confidence: clamp(0.82 + exact.margin * 0.3, 0.82, 0.99), source: "standard-metadata" };
    }

    // Fuzzy matching is deliberately conservative and only helps with small typos
    // in strong single-word labels such as "Vorname" or "Postleitzahl".
    const fuzzyScores = new Map<KnownFieldIntent, number>();
    for (const signal of signals.slice(0, 5)) {
      for (const rule of LEXICAL_RULES) {
        let bestSimilarity = 0;
        for (const term of rule.terms) {
          bestSimilarity = Math.max(bestSimilarity, bestFuzzyTokenSimilarity(signal.value, term));
        }
        if (bestSimilarity < 0.86) continue;
        fuzzyScores.set(rule.intent, Math.max(fuzzyScores.get(rule.intent) ?? 0, signal.weight * bestSimilarity));
      }
    }

    const fuzzy = this.pickMetadataCandidate(fuzzyScores, 0.78, 0.16);
    if (!fuzzy) return undefined;
    return { intent: fuzzy.intent, confidence: clamp(0.74 + fuzzy.margin * 0.35, 0.74, 0.94), source: "standard-metadata" };
  }

  private pickMetadataCandidate(
    scores: Map<KnownFieldIntent, number>,
    minimumScore: number,
    minimumMargin: number
  ): { intent: KnownFieldIntent; score: number; margin: number } | undefined {
    const ranking = Array.from(scores.entries())
      .map(([intent, score]) => ({ intent, score }))
      .sort((left, right) => right.score - left.score);
    const best = ranking[0];
    if (!best || best.score < minimumScore) return undefined;
    const margin = best.score - (ranking[1]?.score ?? 0);
    if (margin < minimumMargin) return undefined;
    return { ...best, margin };
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
        ...item,
        vector: allVectors[index] ?? []
      }));
      fieldVectors = allVectors.slice(prototypeTexts.length);
    } else {
      fieldVectors = await this.provider.embed(fieldTexts);
    }

    unresolved.forEach((item, unresolvedIndex) => {
      const vector = fieldVectors[unresolvedIndex] ?? [];
      const resolution = this.resolveEmbeddingVector(vector);
      this.cache.set(item.key, resolution);
      results[item.position] = { descriptor: item.field, ...resolution };
    });
  }

  private resolveEmbeddingVector(vector: number[]): { intent: FieldIntent; confidence: number; source: ResolvedField["source"] } {
    let candidates: KnownFieldIntent[] | undefined;
    let lastRanking: IntentScore[] = [];

    for (const tier of [1, 2, 3] as const) {
      const ranking = this.rankEmbeddingIntents(vector, tier, candidates);
      lastRanking = ranking;
      const accepted = this.acceptEmbeddingRanking(ranking);
      if (accepted) return accepted;

      // After the broad first pass, expand only the strongest candidates.
      // This avoids unrelated later synonyms diluting a good primary match.
      if (tier === 1) {
        candidates = ranking.slice(0, 3).map(item => item.intent);
      }
    }

    const finalAccepted = this.acceptEmbeddingRanking(lastRanking);
    return finalAccepted ?? { intent: "unknown", confidence: 0, source: "unknown" };
  }

  private rankEmbeddingIntents(
    vector: number[],
    maxTier: PrototypeTier,
    candidates?: KnownFieldIntent[]
  ): IntentScore[] {
    const allowed = candidates ? new Set(candidates) : undefined;
    const bestByIntent = new Map<KnownFieldIntent, number>();

    for (const prototype of this.prototypeVectors ?? []) {
      if (prototype.tier > maxTier) continue;
      if (allowed && !allowed.has(prototype.intent)) continue;
      const score = cosine(vector, prototype.vector);
      bestByIntent.set(prototype.intent, Math.max(bestByIntent.get(prototype.intent) ?? -1, score));
    }

    return Array.from(bestByIntent.entries())
      .map(([intent, score]) => ({ intent, score }))
      .sort((left, right) => right.score - left.score);
  }

  private acceptEmbeddingRanking(
    ranking: IntentScore[]
  ): { intent: FieldIntent; confidence: number; source: ResolvedField["source"] } | undefined {
    const best = ranking[0];
    const second = ranking[1];
    if (!best) return undefined;
    const margin = best.score - (second?.score ?? -1);
    if (best.score < 0.35 || margin < 0.015) return undefined;
    return {
      intent: best.intent,
      confidence: clamp(0.5 + Math.max(0, best.score - 0.35) * 0.65 + margin * 2.5, 0.5, 0.99),
      source: "embedding"
    };
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
