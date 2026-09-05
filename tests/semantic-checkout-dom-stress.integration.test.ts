import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AresBrowserRuntime } from "../src/browser-worker/ares-browser-runtime";
import {
  collectFieldDescriptors,
  FieldSemanticResolver
} from "../src/browser-worker/field-semantic-resolver";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { SemanticProfileMapper } from "../src/browser-worker/semantic-profile-mapper";
import { GhostCursorUiInteractionHelper } from "../src/browser-worker/ui-interaction-helper";
import type { Page } from "../src/browser-worker/types";
import type { AresProfile } from "../src/profiles/models";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

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
    address2: "3. OG",
    street: "Mönckebergstraße",
    houseNumber: "7",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE"
  },
  shippingAddress: {
    address1: "Mönckebergstraße 7",
    address2: "3. OG",
    street: "Mönckebergstraße",
    houseNumber: "7",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE"
  },
  billingAddress: {
    address1: "Alexanderplatz 1",
    address2: "Büro 4",
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

async function runAutofill(page: Page): Promise<SemanticFieldAutofill> {
  const resolver = new FieldSemanticResolver();
  const mapper = new SemanticProfileMapper(profile, { billingMode: "separate-billing-fields" });
  const autofill = new SemanticFieldAutofill(page, new GhostCursorUiInteractionHelper(page), resolver);
  await autofill.fillSemantic(mapper);
  return autofill;
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

  it("collects, resolves, maps and fills a noisy reordered checkout while leaving decoys untouched", async () => {
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
    expect(descriptors.some(item => item.ariaLabel === "Straße und Hausnummer Lieferanschrift")).toBe(true);

    await runAutofill(page);

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
    await runAutofill(page);

    expect(await value(page, "email")).toBe("max@example.test");
    expect(await value(page, "first-name")).toBe("Max");
    expect(await value(page, "last-name")).toBe("Mustermann");
    expect(await value(page, "shipping-address1")).toBe("Mönckebergstraße 7");
    expect(await value(page, "shipping-city")).toBe("Hamburg");
    expect(await value(page, "shipping-postal")).toBe("20095");
    expect(await value(page, "billing-address1")).toBe("Alexanderplatz 1");
    expect(await value(page, "billing-city")).toBe("Berlin");
    expect(await value(page, "billing-postal")).toBe("10178");
  });

  it("handles standards-compliant Mozilla-style shipping/billing autocomplete alternatives and ignores unsupported fields", async () => {
    const html = `<!doctype html><html><body><form>
      <h2>Shipping</h2>
      <label>given-name <input data-slot="s-first" autocomplete="shipping given-name"></label>
      <label>family-name <input data-slot="s-last" autocomplete="shipping family-name"></label>
      <label>name <input data-slot="s-name" autocomplete="shipping name"></label>
      <label>street-address <input data-slot="s-street-address" autocomplete="shipping street-address"></label>
      <label>address-level2 <input data-slot="s-city" autocomplete="shipping address-level2"></label>
      <label>postal-code <input data-slot="s-postal" autocomplete="shipping postal-code"></label>
      <label>country-name <input data-slot="s-country-name" autocomplete="shipping country-name"></label>
      <label>email <input data-slot="s-email" autocomplete="shipping email"></label>
      <label>tel <input data-slot="s-tel" autocomplete="shipping tel"></label>
      <label>organization <input data-slot="s-organization" autocomplete="shipping organization"></label>
      <label>address-level1 <input data-slot="s-level1" autocomplete="shipping address-level1"></label>

      <h2>Billing</h2>
      <label>address-line1 <input data-slot="b-line1" autocomplete="billing address-line1"></label>
      <label>address-line2 <input data-slot="b-line2" autocomplete="billing address-line2"></label>
      <label>address-level2 <input data-slot="b-city" autocomplete="billing address-level2"></label>
      <label>postal-code <input data-slot="b-postal" autocomplete="billing postal-code"></label>
      <label>country <input data-slot="b-country" autocomplete="billing country"></label>
      <label>email <input data-slot="b-email" autocomplete="billing email"></label>
      <label>tel <input data-slot="b-tel" autocomplete="billing tel"></label>
      <label>additional-name <input data-slot="b-additional" autocomplete="billing additional-name"></label>
    </form></body></html>`;

    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: "domcontentloaded" });
    await runAutofill(page);

    expect(await value(page, "s-first")).toBe("Max");
    expect(await value(page, "s-last")).toBe("Mustermann");
    expect(await value(page, "s-name")).toBe("Max Mustermann");
    expect(await value(page, "s-street-address")).toBe("Mönckebergstraße 7");
    expect(await value(page, "s-city")).toBe("Hamburg");
    expect(await value(page, "s-postal")).toBe("20095");
    expect(await value(page, "s-country-name")).toBe("DE");
    expect(await value(page, "s-email")).toBe("max@example.test");
    expect(await value(page, "s-tel")).toBe("+491701234567");

    expect(await value(page, "b-line1")).toBe("Alexanderplatz 1");
    expect(await value(page, "b-line2")).toBe("Büro 4");
    expect(await value(page, "b-city")).toBe("Berlin");
    expect(await value(page, "b-postal")).toBe("10178");
    expect(await value(page, "b-country")).toBe("DE");
    expect(await value(page, "b-email")).toBe("max@example.test");
    expect(await value(page, "b-tel")).toBe("+491701234567");

    expect(await value(page, "s-organization")).toBe("");
    expect(await value(page, "s-level1")).toBe("");
    expect(await value(page, "b-additional")).toBe("");
  });
});
