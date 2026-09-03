import { chromium, type Browser } from "patchright";
import { FieldSemanticResolver, OllamaEmbeddingProvider, collectFieldDescriptors } from "../src/browser-worker/field-semantic-resolver";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { GhostCursorUiInteractionHelper } from "../src/browser-worker/ui-interaction-helper";

const MODEL = process.env["ARES_FIELD_EMBED_MODEL"] || "embeddinggemma:300m-qat-q4_0";

jest.setTimeout(120_000);

describe("one-time real Ollama semantic autofill validation", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("forces ambiguous metadata through Ollama embeddings and fills each value once", async () => {
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

    const provider = new OllamaEmbeddingProvider(
      process.env["ARES_FIELD_EMBED_ENDPOINT"] || "http://127.0.0.1:11434/api/embed",
      MODEL,
      10_000
    );
    const resolver = new FieldSemanticResolver(provider);

    const started = Date.now();
    const descriptors = await collectFieldDescriptors(page);
    const resolved = await resolver.resolve(descriptors);
    const elapsedMs = Date.now() - started;

    const expected = ["firstName", "lastName", "address1", "city", "postalCode", "phone"];
    expect(resolved.map(item => item.intent)).toEqual(expected);
    expect(resolved.every(item => item.source === "embedding")).toBe(true);
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
});
