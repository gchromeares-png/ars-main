import type { Page } from "patchright";
import type { LiveChallengeDetection, LiveChallengeType } from "./types";

export class LiveChallengeDetector {
  /**
   * Prüft einen HTML/URL-Snapshot auf Challenges (vollständig abgesichert gegen null/undefined).
   */
  detectFromSnapshot(url: any = "", html: any = "", title: any = ""): LiveChallengeDetection {
    const safeUrl = typeof url === "string" ? url : String(url ?? "");
    const safeHtml = typeof html === "string" ? html : String(html ?? "");
    const safeTitle = typeof title === "string" ? title : String(title ?? "");

    const lowerUrl = safeUrl.toLowerCase();
    const lowerHtml = safeHtml.toLowerCase();
    const lowerTitle = safeTitle.toLowerCase();

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
        url: safeUrl,
        title: safeTitle
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
        url: safeUrl,
        title: safeTitle
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
        url: safeUrl,
        title: safeTitle
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
        url: safeUrl,
        title: safeTitle
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
        url: safeUrl,
        title: safeTitle
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
        url: safeUrl,
        title: safeTitle
      };
    }

    // Keine Challenge erkannt (reguläre Seite)
    return {
      detected: false,
      url: safeUrl,
      title: safeTitle
    };
  }

  /**
   * Prüft eine aktive Patchright-Page im Browser.
   */
  async detect(page: Page): Promise<LiveChallengeDetection> {
    if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
      return { detected: false, url: "" };
    }

    let url = "";
    try {
      if (typeof page.url === "function") {
        url = page.url() || "";
      }
    } catch {}

    let title = "";
    try {
      if (typeof page.title === "function") {
        title = (await page.title()) || "";
      }
    } catch {}

    let html = "";
    try {
      if (typeof page.content === "function") {
        html = (await page.content()) || "";
      }
    } catch {}

    if (!html) {
      try {
        if (typeof (page as any).evaluate === "function") {
          html = (await page.evaluate(() => document.documentElement?.outerHTML || "")) || "";
        }
      } catch {}
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
