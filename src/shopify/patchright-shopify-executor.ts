import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import type { Page } from "patchright";
import { ITaskExecutor } from "../interfaces";
import { Task } from "../models";
import { AresProfile } from "../profiles/models";
import { BezierCursorService } from "../browser/bezier-cursor-service";
import type { BrowserWorker } from "../browser-worker/browser-worker";
import { PatchrightBrowserWorker } from "../browser-worker/patchright-browser-worker";
import type { ShopifyRuntimeShop } from "../browser-worker/runtime-types";
import { LiveChallengeHandler } from "../challenges/live-challenge-handler";
import type { LiveChallengeResult } from "../challenges/types";

export type { ShopifyRuntimeShop } from "../browser-worker/runtime-types";

interface ShopifyVariant {
  id: number | string;
  title?: string;
  price?: string;
  available?: boolean;
}

interface ShopifyProduct {
  title: string;
  handle: string;
  vendor?: string;
  product_type?: string;
  body_html?: string;
  tags?: string[];
  variants?: ShopifyVariant[];
}

interface ShopifyProductMatch {
  title: string;
  handle: string;
  variantId: number;
  variantTitle: string;
  price?: string;
  matchedTokens?: string[];
  missingTokens?: string[];
}

interface ShopifyFlowResult {
  ok: boolean;
  error?: string;
  product?: ShopifyProductMatch;
}

export class PatchrightShopifyTaskExecutor implements ITaskExecutor {
  private readonly productCache = new Map<string, { expiresAt: number; products: ShopifyProduct[] }>();
  private readonly requestDelayMs = 500;
  private readonly cacheTtlMs = 45_000;
  private readonly maxFallbackPages = 2;
  private readonly cursor = new BezierCursorService();

  constructor(
    private readonly getShop: (shopId: string) => ShopifyRuntimeShop | undefined,
    private readonly getProfile: (profileId: string) => AresProfile | undefined = () => undefined,
    private readonly browserWorker: BrowserWorker = new PatchrightBrowserWorker(),
    private readonly liveChallengeHandler: LiveChallengeHandler = new LiveChallengeHandler()
  ) {}

  async execute(task: Task): Promise<boolean> {
    const shopId = task.config.shopId;
    if (!shopId) {
      task.lastError = "Task hat keine shopId.";
      return false;
    }

    const shop = this.getShop(shopId);
    if (!shop) {
      task.lastError = `Shop ${shopId} ist nicht registriert.`;
      return false;
    }

    const profileId = this.extractProfileId(task);
    if (!profileId) {
      task.lastError = "Kein Profil für den Task ausgewählt.";
      return false;
    }

    const profile = this.getProfile(profileId);
    if (!profile) {
      task.lastError = `Profil ${profileId} ist nicht registriert.`;
      return false;
    }

    const baseUrl = this.normalizeBaseUrl(shop.baseUrl);
    const searchTerm = this.extractSearchTerm(task);
    const headless = profile.browser?.headless ?? this.extractHeadless(task);

    // Each task receives a persistent, isolated Chrome profile owned by BrowserWorker.
    const configuredRoot = process.env["ARES_BROWSER_PROFILE_ROOT"]?.trim();
    const profileRoot = configuredRoot || path.join(os.tmpdir(), "ares-browser-profiles");
    fs.mkdirSync(profileRoot, { recursive: true });
    const userDataDir = path.join(profileRoot, this.safePartitionName(task.id));
    fs.mkdirSync(userDataDir, { recursive: true });

    const proxy = profile.proxy?.host && profile.proxy.port
      ? {
          protocol: profile.proxy.protocol || "http" as const,
          host: profile.proxy.host,
          port: profile.proxy.port,
          username: profile.proxy.username || undefined,
          password: profile.proxy.password || undefined
        }
      : undefined;

    try {
      // Retries of the same logical task reuse the persistent profile directory,
      // but never keep two live contexts for one task ID.
      await this.browserWorker.closeContext(task.id);
      const handle = await this.browserWorker.createContext({
        taskId: task.id,
        userDataDir,
        headless,
        proxy,
        userAgent: profile.browser?.userAgent || undefined,
        viewport: null,
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 15_000
      });
      const page = handle.page;

      const found = await this.findProduct(baseUrl, searchTerm, page);
      if (!found.ok || !found.product) {
        task.lastError = found.error || "Kein passendes verfügbares Shopify-Produkt gefunden.";
        await this.browserWorker.closeContext(task.id).catch(() => undefined);
        return false;
      }

      const cartUrl = new URL(`/cart/${found.product.variantId}:1`, baseUrl).toString();
      await page.goto(cartUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.sleep(900);

      // Handle potential live checkpoint on cart
      await this.liveChallengeHandler.handleLiveChallenge(page, {
        timeoutMs: 30_000,
        bringToFrontOnChallenge: !headless,
        onStatusChange: status => {
          task.config.data = { ...(task.config.data ?? {}), liveChallengeStatus: status };
        }
      });

      const checkoutUrl = new URL("/checkout", baseUrl).toString();
      await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Handle live checkpoint or captcha on checkout entry
      const challengeResult = await this.liveChallengeHandler.handleLiveChallenge(page, {
        timeoutMs: 60_000,
        bringToFrontOnChallenge: !headless,
        onStatusChange: status => {
          task.config.data = { ...(task.config.data ?? {}), liveChallengeStatus: status };
        }
      });

      if (challengeResult.handled && !challengeResult.resolved) {
        task.lastError = challengeResult.error || "Live-Challenge im Browser nicht gelöst.";
        await this.browserWorker.closeContext(task.id).catch(() => undefined);
        return false;
      }

      const checkoutProfile = await this.fillCheckoutProfile(page, profile);

      task.config.data = {
        ...(task.config.data ?? {}),
        profileId,
        browserSession: {
          type: "patchright-chromium",
          isolatedPerTask: true,
          userDataDir
        },
        shopify: {
          product: found.product,
          cartUrl,
          checkoutUrl,
          checkoutOpened: true,
          checkoutProfile,
          finalPaymentSubmitted: false,
          challenge: challengeResult
        }
      };

      return true;
    } catch (error) {
      task.lastError = error instanceof Error ? error.message : String(error);
      await this.browserWorker.closeContext(task.id).catch(() => undefined);
      return false;
    }
  }

  async closeTask(taskId: string): Promise<void> {
    await this.browserWorker.closeContext(taskId);
  }

  async closeAll(): Promise<void> {
    if (this.browserWorker instanceof PatchrightBrowserWorker) {
      await this.browserWorker.shutdown();
      return;
    }

    const health = await this.browserWorker.health();
    await Promise.all(health.contextIds.map(taskId => this.browserWorker.closeContext(taskId)));
  }

  private extractProfileId(task: Task): string | undefined {
    const raw = (task.config.data ?? {})["profileId"];
    return raw ? String(raw) : undefined;
  }

  private extractSearchTerm(task: Task): string {
    const data = task.config.data ?? {};
    const criteria = data["productCriteria"] as Record<string, unknown> | undefined;
    const value = criteria?.["searchTerm"] ?? data["searchTerm"] ?? task.config.name;
    return String(value ?? "").trim();
  }

  private extractHeadless(task: Task): boolean {
    const browserConfig = (task.config.data ?? {})["browserConfig"] as Record<string, unknown> | undefined;
    return Boolean(browserConfig?.["headless"]);
  }

  private safePartitionName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private normalizeBaseUrl(input: string): string {
    const withProtocol = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
    const url = new URL(withProtocol);
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  private async fillCheckoutProfile(
    page: Page,
    profile: AresProfile
  ): Promise<{ filled: string[]; missing: string[] }> {
    const fields = [
      { key: "email", value: profile.contact.email, selectors: ['input[name="email"]', 'input[type="email"]', 'input[autocomplete="email"]'] },
      { key: "firstName", value: profile.contact.firstName, selectors: ['input[name="firstName"]', 'input[name*="first_name" i]', 'input[autocomplete="given-name"]'] },
      { key: "lastName", value: profile.contact.lastName, selectors: ['input[name="lastName"]', 'input[name*="last_name" i]', 'input[autocomplete="family-name"]'] },
      { key: "address1", value: profile.address.address1, selectors: ['input[name="address1"]', 'input[name*="address1" i]', 'input[autocomplete="address-line1"]'] },
      { key: "address2", value: profile.address.address2 || "", selectors: ['input[name="address2"]', 'input[name*="address2" i]', 'input[autocomplete="address-line2"]'] },
      { key: "city", value: profile.address.city, selectors: ['input[name="city"]', 'input[autocomplete="address-level2"]'] },
      { key: "postalCode", value: profile.address.postalCode, selectors: ['input[name="postalCode"]', 'input[name*="postal" i]', 'input[name*="zip" i]', 'input[autocomplete="postal-code"]'] },
      { key: "phone", value: profile.contact.phone || "", selectors: ['input[name="phone"]', 'input[type="tel"]', 'input[autocomplete="tel"]'] }
    ];

    const required = new Set(["email", "firstName", "lastName", "address1", "city", "postalCode"]);
    let filled: string[] = [];
    let missing: string[] = [];

    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) await this.sleep(700);
      if (attempt === 3 || attempt === 7) {
        await this.liveChallengeHandler.handleLiveChallenge(page, { timeoutMs: 20_000 });
      }
      filled = [];
      missing = [];

      for (const field of fields) {
        if (!field.value) continue;
        let done = false;

        for (const selector of field.selectors) {
          const locator = page.locator(selector).first();
          try {
            if (await locator.isVisible({ timeout: 250 })) {
              await this.cursor.clickLocator(page, locator);
              await locator.fill(field.value, { timeout: 1_000 });
              filled.push(field.key);
              done = true;
              break;
            }
          } catch {
            // Checkout may still be rendering; try the next selector/attempt.
          }
        }

        if (!done) missing.push(field.key);
      }

      const countryCode = (profile.address.countryCode || "DE").toUpperCase();
      let countryDone = false;
      for (const selector of ['select[name="countryCode"]', 'select[name*="country" i]']) {
        try {
          const locator = page.locator(selector).first();
          if (await locator.isVisible({ timeout: 250 })) {
            await locator.selectOption(countryCode, { timeout: 1_000 });
            filled.push("countryCode");
            countryDone = true;
            break;
          }
        } catch {
          // Some Shopify checkout versions expose country differently.
        }
      }
      if (!countryDone) missing.push("countryCode");

      if ([...required].every(key => filled.includes(key))) break;
    }

    return { filled: [...new Set(filled)], missing: [...new Set(missing)] };
  }

  private async findProduct(baseUrl: string, searchTerm: string, page?: Page): Promise<ShopifyFlowResult> {
    const requestedTokens = [...new Set(this.tokenize(searchTerm))];
    if (!requestedTokens.length) return { ok: false, error: "Kein Produkt-Keyword angegeben." };

    if (/^https?:\/\//i.test(searchTerm) && searchTerm.includes("/products/")) {
      const productUrl = new URL(searchTerm);
      const handle = productUrl.pathname.split("/products/")[1]?.split("/")[0];
      if (handle) {
        const product = await this.readJson<ShopifyProduct>(new URL(`/products/${handle}.js`, baseUrl).toString(), page);
        const variant = this.chooseAvailableVariant(product);
        if (!variant) return { ok: false, error: `Das angegebene Produkt ist ausverkauft: ${product.title}` };
        return { ok: true, product: this.toMatch(product, variant, requestedTokens, []) };
      }
    }

    const predictive = await this.predictiveSearch(baseUrl, searchTerm, page);
    const products = predictive.length ? predictive : await this.fallbackCatalog(baseUrl, page);
    if (!products.length) return { ok: false, error: "Keine Produkte im Shopify-Katalog gefunden." };

    const scored = products.map(product => {
      const info = this.matchTokens(product, requestedTokens);
      return { product, info, score: info.coverage * 100 + info.matchedWeight * 8 };
    }).sort((a, b) => b.score - a.score);

    for (const entry of scored.filter(item => item.info.coverage >= 0.72)) {
      const fresh = await this.readJson<ShopifyProduct>(new URL(`/products/${entry.product.handle}.js`, baseUrl).toString(), page).catch(() => entry.product);
      const variant = this.chooseAvailableVariant(fresh);
      if (variant) return { ok: true, product: this.toMatch(fresh, variant, entry.info.matchedTokens, entry.info.missingTokens) };
    }

    const best = scored[0];
    return {
      ok: false,
      error: best
        ? `Kein verfügbares Produkt passt ausreichend zu '${searchTerm}'. Bester Treffer: '${best.product.title}' (${Math.round(best.info.coverage * 100)}%).`
        : `Kein verfügbares Produkt passt zu '${searchTerm}'.`
    };
  }

  private normalize(value: unknown): string {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9äöüß]+/gi, " ").replace(/\s+/g, " ").trim();
  }

  private tokenize(value: unknown): string[] {
    return this.normalize(value).split(" ").map(word => word.trim()).filter(word => word.length >= 2);
  }

  private productWords(product: ShopifyProduct): string[] {
    return this.normalize([product.title, product.handle, product.vendor, product.product_type, product.body_html, ...(product.tags || [])].join(" ")).split(" ").filter(Boolean);
  }

  private allowedDistance(token: string): number {
    if (token.length <= 4) return 1;
    if (token.length <= 7) return 2;
    return 3;
  }

  private levenshtein(a: string, b: string): number {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    const current = new Array<number>(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      current[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      }
      for (let j = 0; j <= b.length; j++) previous[j] = current[j];
    }
    return previous[b.length];
  }

  private tokenMatchesWord(token: string, word: string): boolean {
    if (token === word) return true;
    if (token.length >= 5 && word.length >= 5 && (word.includes(token) || token.includes(word))) return true;
    const allowed = this.allowedDistance(token);
    return Math.abs(token.length - word.length) <= allowed && this.levenshtein(token, word) <= allowed;
  }

  private tokenWeight(token: string): number {
    if (token.length >= 10) return 4;
    if (token.length >= 7) return 3;
    if (token.length >= 5) return 2;
    return 1;
  }

  private matchTokens(product: ShopifyProduct, requestedTokens: string[]) {
    const generic = new Set(["the", "and", "und", "der", "die", "das", "ein", "eine", "mit", "von", "for", "fur", "für", "edition", "set", "neu", "new", "deutsch", "englisch", "english", "german"]);
    const important = requestedTokens.filter(token => token.length >= 3 && !generic.has(token));
    const required = important.length ? important : requestedTokens;
    const words = this.productWords(product);
    const matchedTokens = required.filter(token => words.some(word => this.tokenMatchesWord(token, word)));
    const missingTokens = required.filter(token => !matchedTokens.includes(token));
    const totalWeight = required.reduce((sum, token) => sum + this.tokenWeight(token), 0);
    const matchedWeight = matchedTokens.reduce((sum, token) => sum + this.tokenWeight(token), 0);
    return { matchedTokens, missingTokens, matchedWeight, coverage: totalWeight ? matchedWeight / totalWeight : 0 };
  }

  private chooseAvailableVariant(product: ShopifyProduct): ShopifyVariant | undefined {
    return (product.variants || []).find(variant => variant.available !== false);
  }

  private toMatch(product: ShopifyProduct, variant: ShopifyVariant, matchedTokens: string[], missingTokens: string[]): ShopifyProductMatch {
    return { title: product.title, handle: product.handle, variantId: Number(variant.id), variantTitle: variant.title || "Default", price: variant.price, matchedTokens, missingTokens };
  }

  private async predictiveSearch(baseUrl: string, searchTerm: string, page?: Page): Promise<ShopifyProduct[]> {
    const url = new URL("/search/suggest.json", baseUrl);
    url.searchParams.set("q", searchTerm);
    url.searchParams.set("resources[type]", "product");
    url.searchParams.set("resources[limit]", "10");
    url.searchParams.set("resources[options][unavailable_products]", "show");
    try {
      const data = await this.readJson<any>(url.toString(), page);
      const raw = data?.resources?.results?.products ?? [];
      const products: ShopifyProduct[] = [];
      for (const item of raw) {
        const handle = String(item?.handle ?? "");
        if (!handle) continue;
        try {
          const hydrated = await this.readJson<any>(new URL(`/products/${handle}.js`, baseUrl).toString(), page);
          products.push({
            title: String(hydrated.title ?? item.title ?? ""),
            handle: String(hydrated.handle ?? handle),
            vendor: String(hydrated.vendor ?? item.vendor ?? ""),
            product_type: String(hydrated.type ?? ""),
            body_html: String(hydrated.description ?? ""),
            tags: Array.isArray(hydrated.tags) ? hydrated.tags : [],
            variants: Array.isArray(hydrated.variants) ? hydrated.variants.map((variant: any) => ({ id: variant.id, title: variant.title, price: String(variant.price ?? ""), available: Boolean(variant.available) })) : []
          });
        } catch {}
      }
      return products;
    } catch {
      return [];
    }
  }

  private async fallbackCatalog(baseUrl: string, page?: Page): Promise<ShopifyProduct[]> {
    const key = this.normalizeBaseUrl(baseUrl);
    const cached = this.productCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.products;
    const products: ShopifyProduct[] = [];
    for (let pageNum = 1; pageNum <= this.maxFallbackPages; pageNum++) {
      const catalog = await this.readJson<{ products?: ShopifyProduct[] }>(new URL(`/products.json?limit=250&page=${pageNum}`, baseUrl).toString(), page);
      const pageProducts = catalog.products ?? [];
      products.push(...pageProducts);
      if (pageProducts.length < 250) break;
    }
    this.productCache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, products });
    return products;
  }

  private async readJson<T>(url: string, page?: Page, attempt = 0, redirects = 0): Promise<T> {
    await this.sleep(this.requestDelayMs);
    if (page && !page.isClosed()) {
      try {
        const data = await page.evaluate(async (targetUrl) => {
          const res = await fetch(targetUrl, {
            headers: { Accept: "application/json,text/plain,*/*" }
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        }, url);
        return data as T;
      } catch {
        // Fallback to direct HTTP request if page context evaluation fails
      }
    }

    try {
      return await new Promise<T>((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;
        const request = client.get(parsed, {
          headers: {
            Accept: "application/json,text/plain,*/*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          }
        }, response => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if ([301, 302, 303, 307, 308].includes(status) && location && redirects < 5) {
            response.resume();
            this.readJson<T>(new URL(location, parsed).toString(), page, attempt, redirects + 1).then(resolve).catch(reject);
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => {
            if (status < 200 || status >= 300) {
              const error = new Error(`${parsed.pathname} returned ${status}`) as Error & { statusCode?: number };
              error.statusCode = status;
              reject(error);
              return;
            }
            try { resolve(JSON.parse(body) as T); } catch (error) { reject(error); }
          });
        });
        request.on("error", reject);
        request.setTimeout(15_000, () => request.destroy(new Error(`Timeout beim Lesen von ${parsed.pathname}`)));
      });
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      if ((status === 429 || status === 503) && attempt < 3) {
        await this.sleep(800 * Math.pow(2, attempt));
        return this.readJson<T>(url, page, attempt + 1, redirects);
      }
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
