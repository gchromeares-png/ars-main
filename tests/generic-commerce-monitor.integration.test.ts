import * as http from "http";
import type { AddressInfo } from "net";
import type { CommerceShop } from "../src/commerce/platforms";
import { GenericHtmlProductApiAdapter } from "../src/commerce/product-api/generic-html-product-api-adapter";
import { NodeJsonHttpClient } from "../src/commerce/product-api/http-json-client";
import { NodeTextHttpClient } from "../src/commerce/product-api/http-text-client";

describe("generic public storefront monitoring over real HTTP", () => {
  let server: http.Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = request.url || "/";
      if (url === "/redirect-json") {
        response.writeHead(302, { Location: "/final-json" });
        response.end();
        return;
      }
      if (url === "/final-json") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, source: "redirect-target" }));
        return;
      }
      if (url === "/products/gengar-box") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>Pokemon Gengar Box</title>
          <meta itemprop="availability" content="https://schema.org/InStock"></head>
          <body><h1>Pokemon Gengar Box</h1><button>Add to cart</button></body></html>`);
        return;
      }
      if (url === "/products/gengar-sold") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>Pokemon Gengar Box</title></head>
          <body><h1>Pokemon Gengar Box</h1><strong>Sold out</strong></body></html>`);
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Card Store</title></head><body>
        <a href="/products/gengar-box">Pokemon Gengar Box</a>
        <a href="/products/other">Unrelated product</a>
      </body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("follows bounded relative redirects in the real JSON HTTP client", async () => {
    const response = await new NodeJsonHttpClient(2_000).get<{ ok: boolean; source: string }>(`${baseUrl}/redirect-json`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true, source: "redirect-target" });
  });

  it("discovers a matching product link on a non-Shopify storefront and detects availability", async () => {
    const shop: CommerceShop = {
      id: "generic-local",
      name: "Generic Local Store",
      baseUrl,
      platform: "custom",
      config: {}
    };
    const adapter = new GenericHtmlProductApiAdapter(new NodeTextHttpClient(2_000));
    const observations = await adapter.search(shop, { searchTerm: "Pokemon Gengar" }, 10);
    const available = observations.find(item => item.available);

    expect(available).toBeDefined();
    expect(available?.url).toBe(`${baseUrl}/products/gengar-box`);
    expect(available?.attributes?.["source"]).toBe("generic-html");
    expect(String(available?.attributes?.["availabilitySignal"])).toContain("in-stock");
  });

  it("accepts a product URL pasted into the keyword field and remains fail-closed on sold-out text", async () => {
    const shop: CommerceShop = {
      id: "generic-url",
      name: "Generic URL Store",
      baseUrl,
      platform: "custom",
      config: {}
    };
    const adapter = new GenericHtmlProductApiAdapter(new NodeTextHttpClient(2_000));

    const live = await adapter.search(shop, { searchTerm: `${baseUrl}/products/gengar-box` });
    const sold = await adapter.search(shop, { searchTerm: `${baseUrl}/products/gengar-sold` });

    expect(live).toHaveLength(1);
    expect(live[0].available).toBe(true);
    expect(sold).toHaveLength(1);
    expect(sold[0].available).toBe(false);
  });
});
