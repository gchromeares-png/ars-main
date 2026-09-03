import type { Page } from "patchright";
import type { LiveChallengeDetection, LiveChallengeType } from "./types";

export class LiveChallengeDetector {
  /**
   * Prüft einen HTML/URL-Snapshot auf Challenges (wird von der Test-Suite verwendet).
   */
  detectFromSnapshot(url: string, html: string = "", title: string = ""): LiveChallengeDetection {
    const lowerUrl = url.toLowerCase();
    const lowerHtml = html.toLowerCase();
    const lowerTitle = title.toLowerCase();

    // 1. Generic Interstitial (Cloudflare "Just a moment...", etc.)
    if (
      lowerTitle.includes("just a moment") ||
      lowerHtml.includes("cf-browser-verification") ||
      lowerHtml.includes("challenge-running") ||
      (lowerHtml.includes("ray id:") && lowerHtml.includes("cloudflare"))
    ) {
      return {
        detected: true,
        type: "generic-interstitial",
        url,
        title
      };
    }

    // 2. Shopify Queue / Throttle Warteraum
    if (
      lowerUrl.includes("/throttle") ||
      lowerUrl.includes("/queue") ||
      lowerHtml.includes("checkout-queue") ||
      lowerHtml.includes("waiting room")
    ) {
      return {
        detected: true,
        type: "shopify-queue",
        url,
        title
      };
    }

    // 3. Cloudflare Turnstile
    if (
      lowerHtml.includes("cf-turnstile") ||
      lowerHtml.includes("challenges.cloudflare.com") ||
      lowerHtml.includes("turnstile.js") ||
      lowerHtml.includes('name="cf-turnstile-response"')
    ) {
      return {
        detected: true,
        type: "turnstile",
        url,
        title
      };
    }

    // 4. Google reCAPTCHA
    if (
      lowerHtml.includes("g-recaptcha") ||
      lowerHtml.includes("recaptcha/api.js") ||
      lowerHtml.includes('name="g-recaptcha-response"')
    ) {
      return {
        detected: true,
        type: "recaptcha",
        url,
        title
      };
    }

    // 5. hCaptcha
    if (
      lowerHtml.includes("h-captcha") ||
      lowerHtml.includes("hcaptcha.com") ||
      lowerHtml.includes('name="h-captcha-response"')
    ) {
      return {
        detected: true,
        type: "hcaptcha",
        url,
        title
      };
    }

    // 6. Shopify Checkpoint (ohne spezifisches Widget)
    if (
      lowerUrl.includes("/checkpoint") ||
      lowerHtml.includes("form#checkpoint-form") ||
      lowerHtml.includes('action="/checkpoint"')
    ) {
      return {
        detected: true,
        type: "shopify-checkpoint",
        url,
        title
      };
    }

    // Keine Challenge erkannt (reguläre Seite)
    return {
      detected: false,
      url,
      title
    };
  }

  /**
   * Prüft eine aktive Patchright-Page im Browser (abgesichert gegen unvollständige Mocks).
   */
  async detect(page: Page): Promise<LiveChallengeDetection> {
    if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
      return { detected: false, url: "" };
    }

    const url = typeof page.url === "function" ? page.url() : "";
    
    let title = "";
    if (typeof page.title === "function") {
      title = await page.title().catch(() => "");
    }

    let html = "";
    if (typeof page.content === "function") {
      html = await page.content().catch(() => "");
    } else if (typeof (page as any).evaluate === "function") {
      html = await page.evaluate(() => document.documentElement?.outerHTML || "").catch(() => "");
    }

    return this.detectFromSnapshot(url, html, title);
  }
}

export const defaultDetector = new LiveChallengeDetector();

export async function detectLiveChallenge(page: Page): Promise<LiveChallengeDetection> {
  return defaultDetector.detect(page);
}

export function detectFromHtml(html: string, url: string = "", title: string = ""): LiveChallengeDetection {
  return defaultDetector.detectFromSnapshot(url, html, title);
}
