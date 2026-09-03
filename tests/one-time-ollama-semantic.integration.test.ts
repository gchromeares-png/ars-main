import { chromium, type Browser } from "patchright";
import { FieldSemanticResolver, OllamaEmbeddingProvider, collectFieldDescriptors } from "../src/browser-worker/field-semantic-resolver";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { GhostCursorUiInteractionHelper } from "../src/browser-worker/ui-interaction-helper";

const MODEL = process.env["ARES_FIELD_EMBED_MODEL"] || "embeddinggemma:300m-qat-q4_0";
const ENDPOINT = process.env["ARES_FIELD_EMBED_ENDPOINT"] || "http://127.0.0.1:11434/api/embed";

jest.setTimeout(120_000);

describe("one-time real Ollama semantic autofill validation", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("uses the hybrid resolver and fills each German checkout value once", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <html lang="de">
        <body>
          <form>
            <label>Vorname der empfangenden Person <input type="text" name="f1" id="a1"></label>
            <label>Nachname der empfangenden Person <input type="text" name="f2" id="a2"></label>
            <label>Straße und Hausnummer der Lieferanschrift <input type="text" name="f3" id="a3"></label>
            <label>Ort oder Gemeinde der Lieferanschrift <input type="text" name="f4" id="a4"></label>
            <label>Postleitzahl des Zustellgebiets <input type="text" name="f5" id="a5"></label>
            <label>Telefonnummer für Rückfragen <input type="text" name="f6" id="a6"></label>
          </form>
        </body>
      </html>
    `);

    const provider = new OllamaEmbeddingProvider(ENDPOINT, MODEL, 10_000);
    const resolver = new FieldSemanticResolver(provider);

    const started = Date.now();
    const descriptors = await collectFieldDescriptors(page);
    const resolved = await resolver.resolve(descriptors);
    const elapsedMs = Date.now() - started;

    const expected = ["firstName", "lastName", "address1", "city", "postalCode", "phone"];
    expect(resolved.map(item => item.intent)).toEqual(expected);
    expect(resolved.every(item => item.source !== "unknown")).toBe(true);
    expect(resolved.some(item => item.source === "standard-metadata")).toBe(true);
    expect(resolved.every(item => item.confidence >= 0.5)).toBe(true);

    const interactions = new GhostCursorUiInteractionHelper(page);
    const autofill = new SemanticFieldAutofill(page, interactions, resolver);
    const values = {
      firstName: "Max",
      lastName: "Mustermann",
      address1: "Musterweg 12",
      city: "Hamburg",
      postalCode: "20095",
      phone: "+491701234567"
    } as const;

    await autofill.fillSemantic(values);
    await autofill.fillSemantic(values);
    const result = await autofill.result(values);

    expect(result.missing).toEqual([]);
    expect(result.filled.sort()).toEqual(Object.keys(values).sort());
    for (const intent of Object.keys(values)) {
      expect(result.writeCounts[intent]).toBe(1);
    }

    expect(await page.locator("#a1").inputValue()).toBe(values.firstName);
    expect(await page.locator("#a2").inputValue()).toBe(values.lastName);
    expect(await page.locator("#a3").inputValue()).toBe(values.address1);
    expect(await page.locator("#a4").inputValue()).toBe(values.city);
    expect(await page.locator("#a5").inputValue()).toBe(values.postalCode);
    expect(await page.locator("#a6").inputValue()).toBe(values.phone);

    console.log(JSON.stringify({
      phase: "hybrid-autofill",
      platform: process.platform,
      model: MODEL,
      elapsedMs,
      fields: resolved.map(item => ({
        label: item.descriptor.label,
        intent: item.intent,
        source: item.source,
        confidence: item.confidence
      })),
      writeCounts: result.writeCounts
    }, null, 2));

    await page.close();
  });

  it("recognizes German checkout fields across metadata sources and address contexts", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <html lang="de">
        <body>
          <form>
            <input type="text" id="v1" name="customer-given" autocomplete="given-name">
            <input type="text" id="v2" name="customer-family" aria-label="Familienname">
            <input type="text" id="v3" name="billing-line" placeholder="Straße und Hausnummer der Rechnungsanschrift">
            <label for="v4">Ort der Rechnungsanschrift</label>
            <input type="text" id="v4" name="billing-locality">
            <input type="text" id="v5" name="billing-postal" placeholder="PLZ">
            <input type="tel" id="v6" name="contact-number" aria-label="Telefon für Rückfragen">
            <select id="v7" name="billing-country" autocomplete="country-name">
              <option value="DE">Deutschland</option>
              <option value="AT">Österreich</option>
            </select>
          </form>
        </body>
      </html>
    `);

    const provider = new OllamaEmbeddingProvider(ENDPOINT, MODEL, 10_000);
    const resolver = new FieldSemanticResolver(provider);
    const descriptors = await collectFieldDescriptors(page);
    const resolved = await resolver.resolve(descriptors);

    expect(resolved.map(item => item.intent)).toEqual([
      "firstName",
      "lastName",
      "address1",
      "city",
      "postalCode",
      "phone",
      "countryCode"
    ]);
    expect(resolved.every(item => item.source === "standard-metadata")).toBe(true);
    expect(resolved.every(item => item.confidence >= 0.8)).toBe(true);

    console.log(JSON.stringify({
      phase: "german-metadata-variants",
      platform: process.platform,
      fields: resolved.map(item => ({
        id: item.descriptor.id,
        label: item.descriptor.label,
        ariaLabel: item.descriptor.ariaLabel,
        placeholder: item.descriptor.placeholder,
        autocomplete: item.descriptor.autocomplete,
        intent: item.intent,
        source: item.source,
        confidence: item.confidence
      }))
    }, null, 2));

    await page.close();
  });

  it("routes indirect German metadata through real Ollama without forcing an unsafe guess", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <html lang="de">
        <body>
          <form>
            <label>Wie sollen wir Sie persönlich ansprechen? <input type="text" name="fallback1" id="fallback-a1"></label>
            <label>Wohin soll die Sendung gehen? <input type="text" name="fallback2" id="fallback-a2"></label>
            <label>Zusätzliche Angabe zur Zustellung <input type="text" name="fallback3" id="fallback-a3"></label>
          </form>
        </body>
      </html>
    `);

    const provider = new OllamaEmbeddingProvider(ENDPOINT, MODEL, 10_000);
    const embedSpy = jest.spyOn(provider, "embed");
    const resolver = new FieldSemanticResolver(provider);
    const descriptors = await collectFieldDescriptors(page);
    const resolved = await resolver.resolve(descriptors);

    expect(resolved).toHaveLength(3);
    expect(embedSpy).toHaveBeenCalled();
    expect(resolved.every(item => item.source === "embedding" || item.source === "unknown")).toBe(true);

    for (const item of resolved) {
      if (item.source === "embedding") {
        expect(item.intent).not.toBe("unknown");
        expect(item.confidence).toBeGreaterThanOrEqual(0.5);
      } else {
        expect(item.intent).toBe("unknown");
      }
    }

    console.log(JSON.stringify({
      phase: "embedding-fallback-safety",
      platform: process.platform,
      model: MODEL,
      embeddingCalls: embedSpy.mock.calls.length,
      fields: resolved.map(item => ({
        label: item.descriptor.label,
        intent: item.intent,
        source: item.source,
        confidence: item.confidence
      }))
    }, null, 2));

    embedSpy.mockRestore();
    await page.close();
  });
});
