import { chromium, type Page } from "patchright";
import type { SemanticEmbeddingProvider } from "../src/browser-worker/field-semantic-resolver";
import { FieldSemanticResolver } from "../src/browser-worker/field-semantic-resolver";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { SemanticCheckoutProfilePlanner } from "../src/browser-worker/semantic-checkout-profile-planner";
import { semanticTarget, targetKey } from "../src/browser-worker/semantic-target";
import { GhostCursorUiInteractionHelper } from "../src/browser-worker/ui-interaction-helper";
import { toPersistedAresProfile, toProfileV2Draft } from "../src/profiles/profile-v2";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

class NoEmbeddingProvider implements SemanticEmbeddingProvider {
  async embed(): Promise<number[][]> {
    throw new Error("Profile V2 checkout fields must resolve from deterministic metadata.");
  }
}

async function runCheckoutCase(page: Page, shippingCity: string, billingCity: string) {
  await page.setContent(`<!doctype html><html><body>
    <section aria-label="Lieferanschrift">
      <label>Ort der Lieferanschrift
        <input data-slot="shipping-city" autocomplete="shipping address-level2">
      </label>
    </section>
    <section aria-label="Rechnungsanschrift">
      <label>Ort der Rechnungsanschrift
        <input data-slot="billing-city" autocomplete="billing address-level2">
      </label>
    </section>
  </body></html>`);

  const draft = toProfileV2Draft();
  draft.id = `profile-${shippingCity}-${billingCity}`;
  draft.name = "Profile V2 Checkout";
  draft.contact = {
    firstName: "Max",
    lastName: "Mustermann",
    email: "max@example.test"
  };
  draft.shippingAddress = {
    address1: "Mönckebergstraße 7",
    street: "Mönckebergstraße",
    houseNumber: "7",
    postalCode: "20095",
    city: shippingCity,
    countryCode: "DE"
  };
  draft.billingSameAsShipping = false;
  draft.billingAddress = {
    address1: "Alexanderplatz 1",
    street: "Alexanderplatz",
    houseNumber: "1",
    postalCode: billingCity === "Berlin" ? "10178" : "20095",
    city: billingCity,
    countryCode: "DE"
  };

  const profile = toPersistedAresProfile(draft);
  const interactions = new GhostCursorUiInteractionHelper(page);
  const plan = await new SemanticCheckoutProfilePlanner(interactions).prepare(page, profile);
  const resolver = new FieldSemanticResolver(new NoEmbeddingProvider());
  const autofill = new SemanticFieldAutofill(page, interactions, resolver);

  await autofill.fillSemantic(plan.values);
  const shippingTarget = semanticTarget("city", "shipping");
  const billingTarget = semanticTarget("city", "billing");
  const result = await autofill.result(plan.values, [shippingTarget, billingTarget]);

  return {
    profile,
    plan,
    result,
    shippingTarget,
    billingTarget,
    shippingValue: await page.locator('[data-slot="shipping-city"]').inputValue(),
    billingValue: await page.locator('[data-slot="billing-city"]').inputValue()
  };
}

describeBrowser("Profile V2 checkout mapping", () => {
  jest.setTimeout(30_000);

  it("keeps shipping:city and billing:city separate when both values are Hamburg", async () => {
    const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch(() => chromium.launch({ headless: true }));
    try {
      const page = await browser.newPage();
      const output = await runCheckoutCase(page, "Hamburg", "Hamburg");

      expect(output.plan.billingMode).toBe("explicit-billing");
      expect(output.shippingValue).toBe("Hamburg");
      expect(output.billingValue).toBe("Hamburg");
      expect(output.result.missing).toEqual([]);
      expect(new Set(output.result.filled.map(targetKey))).toEqual(new Set([
        targetKey(output.shippingTarget),
        targetKey(output.billingTarget)
      ]));
      expect(output.result.writeCounts[targetKey(output.shippingTarget)]).toBe(1);
      expect(output.result.writeCounts[targetKey(output.billingTarget)]).toBe(1);
      expect(targetKey(output.shippingTarget)).not.toBe(targetKey(output.billingTarget));
    } finally {
      await browser.close();
    }
  });

  it("maps Hamburg shipping and Berlin billing independently end-to-end", async () => {
    const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch(() => chromium.launch({ headless: true }));
    try {
      const page = await browser.newPage();
      const output = await runCheckoutCase(page, "Hamburg", "Berlin");

      expect(output.profile.shippingAddress?.city).toBe("Hamburg");
      expect(output.profile.billingAddress?.city).toBe("Berlin");
      expect(output.shippingValue).toBe("Hamburg");
      expect(output.billingValue).toBe("Berlin");
      expect(output.result.missing).toEqual([]);
      expect(output.result.writeCounts[targetKey(output.shippingTarget)]).toBe(1);
      expect(output.result.writeCounts[targetKey(output.billingTarget)]).toBe(1);
    } finally {
      await browser.close();
    }
  });
});
