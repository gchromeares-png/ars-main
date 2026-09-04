import { chromium } from "patchright";
import type { AresProfile } from "../src/profiles/models";
import type { SemanticEmbeddingProvider } from "../src/browser-worker/field-semantic-resolver";
import { FieldSemanticResolver } from "../src/browser-worker/field-semantic-resolver";
import { SemanticCheckoutProfilePlanner } from "../src/browser-worker/semantic-checkout-profile-planner";
import { evaluateSemanticCheckoutCompletion } from "../src/browser-worker/semantic-checkout-completion";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { targetKey } from "../src/browser-worker/semantic-target";
import { GhostCursorUiInteractionHelper } from "../src/browser-worker/ui-interaction-helper";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

class NoEmbeddingProvider implements SemanticEmbeddingProvider {
  async embed(): Promise<number[][]> {
    throw new Error("Standards should resolve this fixture without embeddings.");
  }
}

const profile: AresProfile = {
  id: "same-as-shipping",
  name: "Same as shipping",
  contact: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test"
  },
  address: {
    address1: "Hafenstraße 2",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE"
  }
};

describeBrowser("semantic same-as-shipping cleanup", () => {
  jest.setTimeout(30_000);

  it("does not mark hidden or disabled billing fields missing after same-as-shipping is active", async () => {
    const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch(() => chromium.launch({ headless: true }));
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><body>
        <section aria-label="Lieferadresse">
          <label>Ort der Lieferanschrift
            <input data-slot="shipping-city" autocomplete="shipping address-level2">
          </label>
        </section>

        <label for="same">Rechnungsanschrift entspricht der Lieferanschrift</label>
        <input id="same" type="checkbox" onchange="
          const billing = document.querySelector('[data-slot=billing-city]');
          billing.disabled = this.checked;
          billing.closest('section').style.display = this.checked ? 'none' : 'block';
        ">

        <section aria-label="Rechnungsanschrift">
          <label>Ort der Rechnungsanschrift
            <input data-slot="billing-city" autocomplete="billing address-level2">
          </label>
        </section>
      </body></html>`);

      const interactions = new GhostCursorUiInteractionHelper(page);
      const plan = await new SemanticCheckoutProfilePlanner(interactions).prepare(page, profile);
      expect(plan.billingMode).toBe("same-as-shipping");
      expect(await page.locator("#same").isChecked()).toBe(true);
      expect(await page.locator('[data-slot="billing-city"]').isDisabled()).toBe(true);
      expect(await page.locator('[data-slot="billing-city"]').isVisible()).toBe(false);

      const resolver = new FieldSemanticResolver(new NoEmbeddingProvider());
      const autofill = new SemanticFieldAutofill(page, interactions, resolver);
      await autofill.fillSemantic(plan.values);

      const observed = autofill.observedTargets();
      const result = await autofill.result(plan.values);
      const requiredTargets = observed.filter(target => target.intent === "city");
      const completion = evaluateSemanticCheckoutCompletion({
        filled: result.filled,
        missing: result.missing,
        requiredTargets
      });

      expect(await page.locator('[data-slot="shipping-city"]').inputValue()).toBe("Hamburg");
      expect(observed.map(targetKey)).toContain("shipping:city");
      expect(observed.map(targetKey)).not.toContain("billing:city");
      expect(result.missing.map(targetKey)).not.toContain("billing:city");
      expect(completion.complete).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
