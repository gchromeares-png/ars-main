import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AresBrowserRuntime } from "../src/browser-worker/ares-browser-runtime";
import type { Page } from "../src/browser-worker/types";
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
  const html = `<!doctype html><html><body>
    <section aria-label="Lieferanschrift"><label>Ort der Lieferanschrift
      <input data-slot="shipping-city" autocomplete="shipping address-level2">
    </label></section>
    <section aria-label="Rechnungsanschrift"><label>Ort der Rechnungsanschrift
      <input data-slot="billing-city" autocomplete="billing address-level2">
    </label></section>
  </body></html>`;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: "domcontentloaded" });

  const draft = toProfileV2Draft();
  draft.id = `profile-${shippingCity}-${billingCity}`;
  draft.name = "Profile V2 Checkout";
  draft.contact = { firstName: "Max", lastName: "Mustermann", email: "max@example.test" };
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
  jest.setTimeout(45_000);

  const runtime = new AresBrowserRuntime();
  let taskId = "";
  let userDataDir = "";
  let page: Page;

  beforeEach(async () => {
    taskId = `profile-v2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ares-profile-v2-"));
    page = (await runtime.createContext({ taskId, userDataDir, headless: true })).page;
  });

  afterEach(async () => {
    if (taskId) await runtime.closeContext(taskId).catch(() => undefined);
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await runtime.shutdown();
  });

  it("keeps shipping:city and billing:city separate when both values are Hamburg", async () => {
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
  });

  it("maps Hamburg shipping and Berlin billing independently end-to-end with a PII-safe trace", async () => {
    const output = await runCheckoutCase(page, "Hamburg", "Berlin");
    expect(output.profile.shippingAddress?.city).toBe("Hamburg");
    expect(output.profile.billingAddress?.city).toBe("Berlin");
    expect(output.shippingValue).toBe("Hamburg");
    expect(output.billingValue).toBe("Berlin");
    expect(output.result.missing).toEqual([]);
    expect(output.result.writeCounts[targetKey(output.shippingTarget)]).toBe(1);
    expect(output.result.writeCounts[targetKey(output.billingTarget)]).toBe(1);

    const trace = output.result.trace;
    expect(trace?.schemaVersion).toBe(1);
    expect(trace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetKey: targetKey(output.shippingTarget), context: "shipping", intent: "city", resolverSource: { intent: "standard-metadata", context: "standard-metadata" }, confidence: 1, billingMode: "explicit-billing", valueAvailable: true, action: "write", result: "filled" }),
      expect.objectContaining({ targetKey: targetKey(output.billingTarget), context: "billing", intent: "city", resolverSource: { intent: "standard-metadata", context: "standard-metadata" }, confidence: 1, billingMode: "explicit-billing", valueAvailable: true, action: "write", result: "filled" })
    ]));

    const serializedTrace = JSON.stringify(trace);
    for (const pii of ["Hamburg", "Berlin", "Mönckebergstraße", "Alexanderplatz", "max@example.test", "Mustermann"]) {
      expect(serializedTrace).not.toContain(pii);
    }
  });
});
