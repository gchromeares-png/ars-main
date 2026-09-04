import * as path from "path";
import { chromium, type Page } from "patchright";
import type { SemanticEmbeddingProvider } from "../../src/browser-worker/field-semantic-resolver";
import { FieldSemanticResolver } from "../../src/browser-worker/field-semantic-resolver";
import { targetKey } from "../../src/browser-worker/semantic-target";
import { toPersistedAresProfile, toProfileV2Draft } from "../../src/profiles/profile-v2";
import { runCheckoutFixtureStage } from "./fixture-runner";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

class NoEmbeddingProvider implements SemanticEmbeddingProvider {
  async embed(): Promise<number[][]> {
    throw new Error("Synthetic checkout fixture should resolve from deterministic metadata.");
  }
}

function fixturePath(name: string): string {
  return path.resolve(__dirname, "../fixtures/checkout/synthetic", name);
}

function explicitBillingProfile() {
  const draft = toProfileV2Draft();
  draft.id = "fixture-explicit-billing";
  draft.name = "Fixture Explicit Billing";
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
    city: "Hamburg",
    countryCode: "DE"
  };
  draft.billingSameAsShipping = false;
  draft.billingAddress = {
    address1: "Alexanderplatz 1",
    street: "Alexanderplatz",
    houseNumber: "1",
    postalCode: "10178",
    city: "Berlin",
    countryCode: "DE"
  };
  return toPersistedAresProfile(draft);
}

function sameAsShippingProfile() {
  const draft = toProfileV2Draft();
  draft.id = "fixture-same-as-shipping";
  draft.name = "Fixture Same As Shipping";
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
    city: "Hamburg",
    countryCode: "DE"
  };
  draft.billingSameAsShipping = true;
  return toPersistedAresProfile(draft);
}

describeBrowser("checkout fixture harness", () => {
  jest.setTimeout(30_000);

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" })
      .catch(() => chromium.launch({ headless: true }));
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page.close();
  });

  it("runs Hamburg/Berlin shipping and billing through the real semantic pipeline", async () => {
    const resolver = new FieldSemanticResolver(new NoEmbeddingProvider());
    const output = await runCheckoutFixtureStage(
      page,
      fixturePath("shipping-billing.fixture.json"),
      explicitBillingProfile(),
      resolver
    );

    expect(output.source).toBe("synthetic");
    expect(output.billingMode).toBe("explicit-billing");
    expect(output.completion.complete).toBe(true);
    expect(await page.locator('[data-slot="shipping-city"]').inputValue()).toBe("Hamburg");
    expect(await page.locator('[data-slot="billing-city"]').inputValue()).toBe("Berlin");

    const keys = new Set(output.autofill.filled.map(targetKey));
    expect(keys).toContain("shipping:city");
    expect(keys).toContain("billing:city");

    const serializedTrace = JSON.stringify(output.autofill.trace);
    for (const pii of ["Hamburg", "Berlin", "Mönckebergstraße", "Alexanderplatz", "max@example.test", "Mustermann"]) {
      expect(serializedTrace).not.toContain(pii);
    }
  });

  it("activates same-as-shipping and completes a shipping-only fixture", async () => {
    const resolver = new FieldSemanticResolver(new NoEmbeddingProvider());
    const output = await runCheckoutFixtureStage(
      page,
      fixturePath("same-as-shipping.fixture.json"),
      sameAsShippingProfile(),
      resolver
    );

    expect(output.billingMode).toBe("same-as-shipping");
    expect(output.completion.complete).toBe(true);
    expect(await page.locator('[data-slot="same-as-shipping"]').isChecked()).toBe(true);
    expect(await page.locator('[data-slot="shipping-city"]').inputValue()).toBe("Hamburg");
  });
});
