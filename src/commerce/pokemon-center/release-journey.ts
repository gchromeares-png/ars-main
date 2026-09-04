import type { Page } from "patchright";
import type { CommerceShop } from "../platforms";
import { ProductMatcher } from "../../monitor/product-matcher";
import type { ProductObservation } from "../../monitor/models";
import type { ReleaseDiscoveryInput, ReleaseJourney } from "../release-discovery/release-journey";

interface JsonLdOffer {
  availability?: unknown;
  price?: unknown;
  priceCurrency?: unknown;
}

interface JsonLdProduct {
  "@type"?: unknown;
  name?: unknown;
  url?: unknown;
  sku?: unknown;
  mpn?: unknown;
  offers?: JsonLdOffer | JsonLdOffer[];
}

function asProducts(value: unknown, result: JsonLdProduct[] = []): JsonLdProduct[] {
  if (Array.isArray(value)) {
    for (const item of value) asProducts(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) result.push(record as JsonLdProduct);
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") asProducts(child, result);
  }
  return result;
}

function firstOffer(product: JsonLdProduct): JsonLdOffer | undefined {
  return Array.isArray(product.offers) ? product.offers[0] : product.offers;
}

function absoluteUrl(value: unknown, baseUrl: string): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  try { return new URL(text, baseUrl).toString(); }
  catch { return undefined; }
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inStock(availability: unknown): boolean {
  return /(?:^|\/)(?:instock|limitedavailability)$/i.test(String(availability ?? "").trim());
}

export class PokemonCenterReleaseJourney implements ReleaseJourney {
  private readonly matcher = new ProductMatcher();

  supports(shop: CommerceShop): boolean {
    try {
      return /(^|\.)pokemoncenter\.com$/i.test(new URL(shop.baseUrl).hostname);
    } catch {
      return false;
    }
  }

  async discover(page: Page, shop: CommerceShop, input: ReleaseDiscoveryInput): Promise<ProductObservation | undefined> {
    const categoryUrl = new URL("/de-de/category/new-releases", shop.baseUrl).toString();
    await page.goto(categoryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const products: JsonLdProduct[] = [];
    for (const script of scripts) {
      try { asProducts(JSON.parse(script) as unknown, products); }
      catch {}
    }

    const criteria = {
      searchTerm: [input.productName, ...input.keywords].filter(Boolean).join(" "),
      requireAvailable: true,
      minimumScore: 0.72
    };
    const ranked: Array<{ observation: ProductObservation; score: number }> = [];
    for (const item of products) {
      const offer = firstOffer(item);
      const observation: ProductObservation = {
        shopId: shop.id,
        platform: shop.platform,
        externalId: String(item.mpn ?? item.sku ?? "").trim() || undefined,
        sku: String(item.sku ?? item.mpn ?? "").trim() || undefined,
        title: String(item.name ?? "").trim(),
        url: absoluteUrl(item.url, shop.baseUrl),
        available: inStock(offer?.availability),
        price: numberValue(offer?.price) !== undefined
          ? { amount: numberValue(offer?.price)!, currency: String(offer?.priceCurrency ?? "").trim() || undefined }
          : undefined,
        observedAt: new Date(),
        attributes: { source: "pokemon-center-jsonld" }
      };
      if (!observation.title || !observation.url) continue;
      const match = this.matcher.match(observation, criteria);
      if (match.matched) ranked.push({ observation, score: match.score });
    }
    ranked.sort((a, b) => b.score - a.score);

    for (const candidate of ranked) {
      await page.goto(candidate.observation.url!, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const add = page.locator("button").filter({ hasText: "In den Einkaufswagen" }).first();
      const usable = await add.isVisible().catch(() => false) && await add.isEnabled().catch(() => false);
      if (usable) return candidate.observation;
    }
    return undefined;
  }

  async addToCart(page: Page, shop: CommerceShop, _product: ProductObservation): Promise<void> {
    const add = page.locator("button").filter({ hasText: "In den Einkaufswagen" }).first();
    if (!(await add.isVisible().catch(() => false)) || !(await add.isEnabled().catch(() => false))) {
      throw new Error("Pokémon-Center-Produkt ist nicht mehr in den Einkaufswagen legbar.");
    }
    await add.click();
    await page.waitForTimeout(600);
    const cartUrl = new URL("/de-de/cart", shop.baseUrl).toString();
    await page.goto(cartUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const guest = page.locator("#guest-checkout").first();
    if (!(await guest.isVisible().catch(() => false))) {
      throw new Error("Pokémon-Center-Warenkorb enthält keinen sichtbaren Gast-Checkout.");
    }
  }

  async openCheckout(page: Page, _shop: CommerceShop): Promise<void> {
    const guestById = page.locator("#guest-checkout").first();
    const guest = await guestById.isVisible().catch(() => false)
      ? guestById
      : page.locator("button").filter({ hasText: "Als Gast zur Kasse" }).first();
    if (!(await guest.isVisible().catch(() => false)) || !(await guest.isEnabled().catch(() => false))) {
      throw new Error("Pokémon-Center-Gast-Checkout ist nicht verfügbar.");
    }
    await guest.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
    const title = await page.title().catch(() => "");
    const current = page.url();
    if (!/(checkout|global-e|international)/i.test(`${title} ${current}`)) {
      throw new Error("Pokémon-Center-Checkout wurde nach Gast-Checkout nicht bestätigt.");
    }
  }
}
