import type { Page } from "patchright";
import type { LiveChallengeDetection, LiveChallengeType } from "./types";

export class LiveChallengeDetector {
  async detect(page: Page): Promise<LiveChallengeDetection> {
    if (page.isClosed()) {
      return { detected: false, url: "" };
    }

    const currentUrl = page.url();

    // Checkpoint & Queue URLs
    if (currentUrl.includes("/checkpoint")) {
      return {
        detected: true,
        type: "shopify-checkpoint",
        url: currentUrl,
        title: await page.title().catch(() => "")
      };
    }

    if (currentUrl.includes("/throttle") || currentUrl.includes("/queue")) {
      return {
        detected: true,
        type: "shopify-queue",
        url: currentUrl,
        title: await page.title().catch(() => "")
      };
    }

    // DOM-Prüfung auf Captcha-Elemente
    const domDetection = await page.evaluate(() => {
      const hasTurnstile = Boolean(
        document.querySelector('input[name="cf-turnstile-response"]') ||
        document.querySelector('.cf-turnstile') ||
        document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        document.querySelector('iframe[src*="turnstile"]')
      );
      if (hasTurnstile) return "turnstile";

      const hasRecaptcha = Boolean(
        document.querySelector('textarea[name="g-recaptcha-response"]') ||
        document.querySelector('.g-recaptcha') ||
        document.querySelector('iframe[src*="google.com/recaptcha"]')
      );
      if (hasRecaptcha) return "recaptcha";

      const hasHcaptcha = Boolean(
        document.querySelector('textarea[name="h-captcha-response"]') ||
        document.querySelector('.h-captcha') ||
        document.querySelector('iframe[src*="hcaptcha.com"]')
      );
      if (hasHcaptcha) return "hcaptcha";

      if (document.title.toLowerCase().includes("just a moment") || document.querySelector("#challenge-running")) {
        return "generic-interstitial";
      }

      return null;
    }).catch(() => null);

    if (domDetection) {
      return {
        detected: true,
        type: domDetection as LiveChallengeType,
        url: currentUrl,
        title: await page.title().catch(() => "")
      };
    }

    return {
      detected: false,
      url: currentUrl
    };
  }
}

export const defaultDetector = new LiveChallengeDetector();

export async function detectLiveChallenge(page: Page): Promise<LiveChallengeDetection> {
  return defaultDetector.detect(page);
}

export function detectFromHtml(html: string, url: string = ""): LiveChallengeDetection {
  if (html.includes("cf-turnstile-response") || html.includes("challenges.cloudflare.com")) {
    return { detected: true, type: "turnstile", url };
  }
  if (html.includes("g-recaptcha-response") || html.includes("google.com/recaptcha")) {
    return { detected: true, type: "recaptcha", url };
  }
  if (html.includes("h-captcha-response") || html.includes("hcaptcha.com")) {
    return { detected: true, type: "hcaptcha", url };
  }
  if (url.includes("/checkpoint")) {
    return { detected: true, type: "shopify-checkpoint", url };
  }
  return { detected: false, url };
}