import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AresBrowserRuntime } from "../src/browser-worker/ares-browser-runtime";
import {
  collectFieldDescriptors,
  FieldSemanticResolver,
  type SemanticEmbeddingProvider
} from "../src/browser-worker/field-semantic-resolver";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { SemanticProfileMapper } from "../src/browser-worker/semantic-profile-mapper";
import { GhostCursorUiInteractionHelper } from "../src/browser-worker/ui-interaction-helper";
import type { Page } from "../src/browser-worker/types";
import type { AresProfile } from "../src/profiles/models";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

class EmbeddingTripwire implements SemanticEmbeddingProvider {
  calls = 0;

  async embed(): Promise<number[][]> {
    this.calls += 1;
    throw new Error("DOM checkout guard: deterministic checkout must not invoke embeddings.");
  }
}

const profile: AresProfile = {
  id: "dom-stress-profile",
  name: "DOM Stress Profile",
  contact: {
    firstName: "Max",
    lastName: "Mustermann",
    email: "max@example.test",
    phone: "+491701234567"
  },
  address: {
    address1: "Mönckebergstraße 7",
    street: "Mönckebergstraße",
    houseNumber: "7",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE"
  },
  shippingAddress: {
    address1: "Mönckebergstraße 7",
    street: "Mönckebergstraße",
    houseNumber: "7",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE"
  },
  billingAddress: {
    address1: "Alexanderplatz 1",
    street: "Alexanderplatz",
    houseNumber: "1",
    postalCode: "10178",
    city: "Berlin",
    countryCode: "DE"
  },
  browser: { kiAutofill: true }
};

async function value(page: Page, slot: string): Promise<string> {
  return page.locator(`[data-slot="${slot}"]`).inputValue();
}

describeBrowser("semantic checkout DOM stress guard", () => {
  jest.setTimeout(60_000);

  const runtime = new AresBrowserRuntime();
  let taskId = "";
  let userDataDir = "";
  let page: Page;

  beforeEach(async () => {
    taskId = `semantic-dom-stress-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ares-semantic-dom-stress-"));
    page = (await runtime.createContext({ taskId, userDataDir, headless: true })).page;
  });

  afterEach(async () => {
    if (taskId) await runtime.closeContext(taskId).catch(() => undefined);
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await runtime.shutdown();
  });

  it("collects, resolves, maps and fills a noisy reordered checkout without embeddings", async () => {
    const html = `<!doctype html><html><body>
      <form>
        <div style="display:none"><label>Vorname<input data-slot="hidden-decoy" name="first_name_decoy"></label></div>

        <section aria-label="Rechnungsanschrift">
          <label for="bill-city">Ort der Rechnungsanschrift</label>
          <input id="bill-city" data-slot="billing-city" autocomplete="billing address-level2">
          <input data-slot="billing-postal" aria-label="Postleitzahl Rechnungsadresse" name="invoice_postal">
          <input data-slot="billing-address1" placeholder="Straße und Hausnummer Rechnungsadresse">
        </section>

        <input data-slot="email" type="email" name="checkout_contact">

        <section aria-label="Lieferanschrift">
          <input data-slot="shipping-postal" id="shipping-postal-code" autocomplete="shipping postal-code">
          <label>Nachname <input data-slot="last-name" name="family_name"></label>
          <input data-slot="shipping-address1" aria-label="Straße und Hausnummer Lieferanschrift">
          <input data-slot="first-name" placeholder="Vorname" name="customer_given">
          <div>Lieferanschrift <input data-slot="shipping-city" name="city" placeholder="Ort"></div>
        </section>

        <input data-slot="phone" type="tel" aria-label="Telefonnummer">
        <input data-slot="ambiguous-decoy" name="customer_reference" placeholder="Referenz">
      </form>
    </body></html>`;

    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: "domcontentloaded" });

    const descriptors = await collectFieldDescriptors(page);
    expect(descriptors.length).toBe(12);
    expect(descriptors.some(item => item.label.includes("Ort der Rechnungsanschrift"))).toBe(true);
    expect(descriptors.some(item => item.placeholder === "Straße und Hausnummer Lieferanschrift")).toBe(false);
    expect(descriptors.some(item => item.ariaLabel === "Straße und Hausnummer Lieferanschrift")).toBe(true);

    const provider = new EmbeddingTripwire();
    const resolver = new FieldSemanticResolver(provider);
    const interactions = new GhostCursorUiInteractionHelper(page);
    const mapper = new SemanticProfileMapper(profile, { billingMode: "separate-billing-fields" });
    const autofill = new SemanticFieldAutofill(page, interactions, resolver);

    await autofill.fillSemantic(mapper);

    expect(await value(page, "email")).toBe("max@example.test");
    expect(await value(page, "first-name")).toBe("Max");
    expect(await value(page, "last-name")).toBe("Mustermann");
    expect(await value(page, "phone")).toBe("+491701234567");
    expect(await value(page, "shipping-address1")).toBe("Mönckebergstraße 7");
    expect(await value(page, "shipping-city")).toBe("Hamburg");
    expect(await value(page, "shipping-postal")).toBe("20095");
    expect(await value(page, "billing-address1")).toBe("Alexanderplatz 1");
    expect(await value(page, "billing-city")).toBe("Berlin");
    expect(await value(page, "billing-postal")).toBe("10178");

    expect(await value(page, "hidden-decoy")).toBe("");
    expect(await value(page, "ambiguous-decoy")).toBe("");
    expect(provider.calls).toBe(0);
  });

  it("stays correct when the same checkout semantics move to different DOM metadata", async () => {
    const html = `<!doctype html><html><body>
      <form>
        <div>Lieferanschrift
          <input data-slot="shipping-city" aria-label="Stadt">
          <input data-slot="shipping-address1" name="shipping_street_address">
          <input data-slot="shipping-postal" placeholder="PLZ">
        </div>
        <input data-slot="last-name" id="customer-last-name">
        <input data-slot="email" autocomplete="email">
        <input data-slot="first-name" aria-label="Vorname">
        <div>Rechnungsadresse
          <input data-slot="billing-postal" name="billing_zip_code">
          <input data-slot="billing-address1" aria-label="Anschrift Rechnungsadresse">
          <input data-slot="billing-city" placeholder="Stadt Rechnungsadresse">
        </div>
      </form>
    </body></html>`;

    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: "domcontentloaded" });

    const provider = new EmbeddingTripwire();
    const resolver = new FieldSemanticResolver(provider);
    const mapper = new SemanticProfileMapper(profile, { billingMode: "separate-billing-fields" });
    const autofill = new SemanticFieldAutofill(page, new GhostCursorUiInteractionHelper(page), resolver);

    await autofill.fillSemantic(mapper);

    expect(await value(page, "email")).toBe("max@example.test");
    expect(await value(page, "first-name")).toBe("Max");
    expect(await value(page, "last-name")).toBe("Mustermann");
    expect(await value(page, "shipping-address1")).toBe("Mönckebergstraße 7");
    expect(await value(page, "shipping-city")).toBe("Hamburg");
    expect(await value(page, "shipping-postal")).toBe("20095");
    expect(await value(page, "billing-address1")).toBe("Alexanderplatz 1");
    expect(await value(page, "billing-city")).toBe("Berlin");
    expect(await value(page, "billing-postal")).toBe("10178");
    expect(provider.calls).toBe(0);
  });
});
