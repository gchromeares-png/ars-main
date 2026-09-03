import type { CommerceShop } from "../src/commerce/platforms";
import { CommerceProductApiRouter } from "../src/commerce/product-api/router";
import { ShopifyProductApiAdapter } from "../src/commerce/product-api/shopify-product-api-adapter";
import { WooCommerceProductApiAdapter } from "../src/commerce/product-api/woocommerce-product-api-adapter";
import type { JsonHttpClient, JsonHttpResponse } from "../src/commerce/product-api/types";

class StubHttpClient implements JsonHttpClient {
  constructor(private readonly handler: (url: string) => JsonHttpResponse<any>) {}
  async get<T>(url: string): Promise<JsonHttpResponse<T>> {
    return this.handler(url) as JsonHttpResponse<T>;
  }
}

const shopifyShop: CommerceShop = {
  id: "shopify-test",
  name: "Shopify Test",
  baseUrl: "https://example.test",
  platform: "shopify",
  config: {}
};

const wooShop: CommerceShop = {
  id: "woo-test",
  name: "Woo Test",
  baseUrl: "https://woo.test",
  platform: "woocommerce",
  config: {}
};

describe("commerce public product API adapters", () => {
  it("probes Shopify products.json as an anonymous product source", async () => {
    const adapter = new ShopifyProductApiAdapter(new StubHttpClient(url => ({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { products: [] }
    })));

    const result = await adapter.probe(shopifyShop);
    expect(result.publicReadable).toBe(true);
    expect(result.endpoint).toContain("/products.json?limit=1");
  });

  it("normalizes Shopify catalog variants without inventing stock quantity", async () => {
    const adapter = new ShopifyProductApiAdapter(new StubHttpClient(() => ({
      status: 200,
      headers: {},
      data: {
        products: [{
          id: 10,
          title: "Pokemon Box",
          handle: "pokemon-box",
          vendor: "Cards",
          variants: [{ id: 11, title: "Default", price: "12.99", available: true, sku: "BOX-1" }]
        }]
      }
    })));

    const results = await adapter.search(shopifyShop, { searchTerm: "Pokemon Box" });
    expect(results).toHaveLength(1);
    expect(results[0].price?.amount).toBe(12.99);
    expect(results[0].available).toBe(true);
    expect(results[0].stock).toBeUndefined();
    expect(results[0].sku).toBe("BOX-1");
  });

  it("normalizes Shopify Ajax product prices from minor units", async () => {
    const adapter = new ShopifyProductApiAdapter(new StubHttpClient(() => ({
      status: 200,
      headers: {},
      data: {
        id: 10,
        title: "Pokemon Box",
        handle: "pokemon-box",
        variants: [{ id: 11, price: 1299, available: true }]
      }
    })));

    const results = await adapter.search(shopifyShop, { url: "https://example.test/products/pokemon-box" });
    expect(results[0].price?.amount).toBe(12.99);
  });

  it("uses WooCommerce Store API query parameters and currency minor units", async () => {
    let requestedUrl = "";
    const adapter = new WooCommerceProductApiAdapter(new StubHttpClient(url => {
      requestedUrl = url;
      return {
        status: 200,
        headers: {},
        data: [{
          id: 34,
          name: "Pokemon Booster",
          slug: "pokemon-booster",
          permalink: "https://woo.test/product/pokemon-booster/",
          sku: "PKM-34",
          is_in_stock: true,
          prices: { price: "1299", currency_code: "EUR", currency_minor_unit: 2 }
        }]
      };
    }));

    const results = await adapter.search(wooShop, { searchTerm: "Pokemon", sku: "PKM-34" }, 10);
    expect(requestedUrl).toContain("/wp-json/wc/store/v1/products?");
    expect(requestedUrl).toContain("search=Pokemon");
    expect(requestedUrl).toContain("sku=PKM-34");
    expect(results[0].price).toEqual({ amount: 12.99, currency: "EUR" });
    expect(results[0].available).toBe(true);
  });

  it("does not pretend credentialed platforms have anonymous adapters", async () => {
    const router = new CommerceProductApiRouter(false);
    const wixShop: CommerceShop = {
      id: "wix-test",
      name: "Wix",
      baseUrl: "https://example.wixsite.com/store",
      platform: "wix",
      config: {}
    };

    await expect(router.search(wixShop, { searchTerm: "Pokemon" }))
      .rejects.toThrow("auth-required");
  });
});
