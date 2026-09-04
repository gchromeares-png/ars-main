import { chromium, type Locator, type Page } from "patchright";
import type { SemanticEmbeddingProvider } from "../src/browser-worker/field-semantic-resolver";
import { FieldSemanticResolver } from "../src/browser-worker/field-semantic-resolver";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { semanticTarget, targetKey } from "../src/browser-worker/semantic-target";
import { SemanticTargetValueMap } from "../src/browser-worker/semantic-target-values";
import { GhostCursorUiInteractionHelper, type UiFillOptions } from "../src/browser-worker/ui-interaction-helper";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

class NoEmbeddingProvider implements SemanticEmbeddingProvider {
  async embed(): Promise<number[][]> {
    throw new Error("Standards should resolve these targets without embeddings.");
  }
}

class RecordingInteractions extends GhostCursorUiInteractionHelper {
  readonly fillSeeds: string[] = [];

  constructor(page: Page) {
    super(page);
  }

  override async fill(target: Locator, value: string, options: UiFillOptions = {}): Promise<void> {
    if (options.seed !== undefined) this.fillSeeds.push(String(options.seed));
    await super.fill(target, value, options);
  }
}

describeBrowser("semantic target context identity", () => {
  jest.setTimeout(30_000);

  it("tracks shipping:city and billing:city independently across fill, missing and retry", async () => {
    const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch(() => chromium.launch({ headless: true }));
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><body>
        <label>Lieferort<input data-slot="shipping-city" autocomplete="shipping address-level2"></label>
        <label>Rechnungsort<input data-slot="billing-city" autocomplete="billing address-level2"></label>
      </body></html>`);

      const shippingCity = semanticTarget("city", "shipping");
      const billingCity = semanticTarget("city", "billing");
      const both = new SemanticTargetValueMap([
        { target: shippingCity, value: "Hamburg" },
        { target: billingCity, value: "Hamburg" }
      ]);
      const resolver = new FieldSemanticResolver(new NoEmbeddingProvider());
      const interactions = new RecordingInteractions(page);
      const autofill = new SemanticFieldAutofill(page, interactions, resolver);

      await autofill.fillSemantic(both);
      await autofill.fillSemantic(both);

      expect(await page.locator('[data-slot="shipping-city"]').inputValue()).toBe("Hamburg");
      expect(await page.locator('[data-slot="billing-city"]').inputValue()).toBe("Hamburg");

      let result = await autofill.result(both, [shippingCity, billingCity]);
      expect(result.missing).toEqual([]);
      expect(new Set(result.filled.map(targetKey))).toEqual(new Set([targetKey(shippingCity), targetKey(billingCity)]));
      expect(result.writeCounts[targetKey(shippingCity)]).toBe(1);
      expect(result.writeCounts[targetKey(billingCity)]).toBe(1);
      expect(interactions.fillSeeds).toContain(`semantic-fill:${targetKey(shippingCity)}`);
      expect(interactions.fillSeeds).toContain(`semantic-fill:${targetKey(billingCity)}`);

      // Invalidate only billing. Shipping must remain complete while billing independently retries.
      await page.locator('[data-slot="billing-city"]').fill("");
      await autofill.fillSemantic(both);
      result = await autofill.result(both, [shippingCity, billingCity]);

      expect(result.missing).toEqual([]);
      expect(result.writeCounts[targetKey(shippingCity)]).toBe(1);
      expect(result.writeCounts[targetKey(billingCity)]).toBe(2);
      expect(interactions.fillSeeds.filter(seed => seed === `semantic-fill:${targetKey(shippingCity)}`)).toHaveLength(1);
      expect(interactions.fillSeeds.filter(seed => seed === `semantic-fill:${targetKey(billingCity)}`)).toHaveLength(2);

      // A mapper/value source can independently mark billing missing even when shipping has the same intent.
      await page.locator('[data-slot="shipping-city"]').fill("");
      await page.locator('[data-slot="billing-city"]').fill("");
      const shippingOnly = new SemanticTargetValueMap([{ target: shippingCity, value: "Hamburg" }]);
      const missingInteractions = new RecordingInteractions(page);
      const missingAutofill = new SemanticFieldAutofill(page, missingInteractions, resolver);
      await missingAutofill.fillSemantic(shippingOnly);
      const missingResult = await missingAutofill.result(shippingOnly, [shippingCity, billingCity]);

      expect(new Set(missingResult.filled.map(targetKey))).toEqual(new Set([targetKey(shippingCity)]));
      expect(new Set(missingResult.missing.map(targetKey))).toEqual(new Set([targetKey(billingCity)]));
      expect(missingResult.writeCounts[targetKey(shippingCity)]).toBe(1);
      expect(missingResult.writeCounts[targetKey(billingCity)]).toBeUndefined();
    } finally {
      await browser.close();
    }
  });
});