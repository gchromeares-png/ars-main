import { COMMERCE_PLATFORMS, normalizeCommercePlatform } from "../src/commerce/platforms";
import { ProductMatcher } from "../src/monitor/product-matcher";
import { ProductMonitor } from "../src/monitor/product-monitor";
import type { ProductObservation } from "../src/monitor/models";

function observation(overrides: Partial<ProductObservation> = {}): ProductObservation {
  return {
    shopId: "shop-1",
    platform: "woocommerce",
    externalId: "product-42",
    sku: "PKM-42",
    gtin: "4000000000042",
    title: "Pokemon Mega Gengar Collection",
    url: "https://example.test/product/42",
    variantId: "v1",
    variantTitle: "Standard",
    available: true,
    stock: 3,
    price: { amount: 39.99, currency: "EUR" },
    attributes: { language: "DE", category: "Pokemon" },
    observedAt: new Date("2026-09-03T08:00:00Z"),
    ...overrides
  };
}

describe("commerce platform model", () => {
  it("contains the major supported registry platforms", () => {
    expect(COMMERCE_PLATFORMS).toEqual(expect.arrayContaining([
      "shopify",
      "woocommerce",
      "jtl",
      "wix",
      "shopware",
      "magento",
      "bigcommerce",
      "prestashop",
      "squarespace",
      "ecwid",
      "lightspeed",
      "commercetools",
      "salesforce-commerce-cloud",
      "custom"
    ]));
  });

  it("normalizes platform names without accepting unknown values", () => {
    expect(normalizeCommercePlatform(" WooCommerce ")).toBe("woocommerce");
    expect(normalizeCommercePlatform("JTL")).toBe("jtl");
    expect(normalizeCommercePlatform("unknown-shop-system")).toBeUndefined();
  });
});

describe("ProductMatcher", () => {
  it("matches normalized observations independently of commerce platform", () => {
    const matcher = new ProductMatcher();
    const result = matcher.match(observation({ platform: "wix" }), {
      searchTerm: "Pokemon Gengar Collection",
      sku: "PKM-42",
      requireAvailable: true
    });

    expect(result.matched).toBe(true);
    expect(result.score).toBe(1);
    expect(result.missingTokens).toEqual([]);
  });

  it("rejects hard identifiers that do not match", () => {
    const matcher = new ProductMatcher();
    const result = matcher.match(observation(), { gtin: "9999999999999" });

    expect(result.matched).toBe(false);
    expect(result.reasons[0]).toContain("GTIN");
  });
});

describe("ProductMonitor", () => {
  it("detects stock, availability and price changes for any platform", () => {
    const monitor = new ProductMonitor();
    const criteria = { searchTerm: "Pokemon Gengar" };

    expect(monitor.observe(observation(), criteria)?.type).toBe("first-seen");
    expect(monitor.observe(observation({ stock: 7, observedAt: new Date("2026-09-03T08:01:00Z") }), criteria)?.type)
      .toBe("stock-increased");
    expect(monitor.observe(observation({ stock: 7, available: false, observedAt: new Date("2026-09-03T08:02:00Z") }), criteria)?.type)
      .toBe("availability-changed");
    expect(monitor.observe(observation({ stock: 7, available: false, price: { amount: 34.99, currency: "EUR" }, observedAt: new Date("2026-09-03T08:03:00Z") }), criteria)?.type)
      .toBe("price-changed");
  });

  it("keeps product identities separate across shops and platforms", () => {
    const monitor = new ProductMonitor();
    const first = monitor.observe(observation({ platform: "shopware", shopId: "a" }));
    const second = monitor.observe(observation({ platform: "shopware", shopId: "b" }));
    const third = monitor.observe(observation({ platform: "wix", shopId: "a" }));

    expect(first?.type).toBe("first-seen");
    expect(second?.type).toBe("first-seen");
    expect(third?.type).toBe("first-seen");
    expect(new Set([first?.key, second?.key, third?.key]).size).toBe(3);
  });
});
