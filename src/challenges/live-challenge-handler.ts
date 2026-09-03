import { CapMonsterSolver } from './capmonster-solver';
import type { Page } from "patchright";
import { LiveChallengeDetector } from "./live-challenge-detector";
import type {
  LiveChallengeDetection,
  LiveChallengeOptions,
  LiveChallengeResult
} from "./types";

export class LiveChallengeHandler {
  constructor(private readonly detector: LiveChallengeDetector = new LiveChallengeDetector()) {}

  /**
   * Main entry point for Live-Captcha handling in the active browser page.
   * Detects if a challenge is present and handles automated resolution or
   * waits for user solving in the live browser session.
   */
  async handleLiveChallenge(page: Page, options: LiveChallengeOptions = {}): Promise<LiveChallengeResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 500;

    const detection = await this.detector.detect(page);
    if (!detection.detected) {
      return {
        handled: false,
        resolved: true,
        durationMs: 0
      };
    }

    if (options.bringToFrontOnChallenge !== false) {
      await page.bringToFront().catch(() => undefined);
    }

    options.onStatusChange?.(
      `Live-Challenge erkannt (${detection.type ?? "unbekannt"}). Starte Handling...`,
      detection
    );

    // =========================================================================
    // 🚀 CAPMONSTER AUTO-SOLVE WEICHE
    // =========================================================================
    const capmonsterKey = process.env['CAPMONSTER_API_KEY'];

    if (capmonsterKey && (detection.type === 'turnstile' || detection.type === 'recaptcha' || detection.type === 'shopify-checkpoint')) {
      try {
        // Sitekey aus dem DOM oder Iframe-Src extrahieren
        const sitekey = await page.evaluate(() => {
          const el = document.querySelector('[data-sitekey]');
          if (el) return el.getAttribute('data-sitekey');

          const frame = document.querySelector('iframe[src*="sitekey="]') as HTMLIFrameElement;
          if (frame && frame.src) {
            const match = frame.src.match(/sitekey=([^&]+)/);
            if (match) return decodeURIComponent(match[1]);
          }
          return null;
        });

        if (sitekey) {
          options.onStatusChange?.(
            `CapMonster aktiv: Löse Challenge (${detection.type}) via Cloud-Dienst...`,
            detection
          );

          const solver = new CapMonsterSolver(capmonsterKey);
          const challengeType = detection.type === 'shopify-checkpoint' ? 'turnstile' : detection.type;

          const token = await solver.solve(challengeType, page.url(), sitekey);
          await solver.injectAndSubmit(page, challengeType, token);

          // Kurz warten und prüfen, ob die Challenge gelöst ist
          await this.sleep(1200);
          const isResolved = await this.checkIfResolved(page);

          if (isResolved) {
            options.onStatusChange?.(
              `Live-Challenge (${detection.type}) erfolgreich durch CapMonster gelöst!`,
              detection
            );
            return {
              handled: true,
              type: detection.type,
              resolved: true,
              durationMs: Date.now() - startTime
            };
          }
        }
      } catch (solverErr: any) {
        options.onStatusChange?.(
          `CapMonster fehlgeschlagen (${solverErr?.message || solverErr}). Wechsle zu normalem Browser-Handling...`,
          detection
        );
      }
    }
    // =========================================================================

    // Initial automated interaction attempt (z. B. Turnstile Checkbox-Klick)
    if (detection.type === "turnstile" && options.autoSolveTurnstile !== false) {
      await this.attemptTurnstileClick(page);
    } else if (detection.type === "shopify-checkpoint") {
      await this.attemptCheckpointSubmit(page);
    }

    let lastInteractionTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) {
        return {
          handled: true,
          type: detection.type,
          resolved: false,
          durationMs: Date.now() - startTime,
          error: "Browser-Seite wurde während der Live-Challenge geschlossen."
        };
      }

      const isResolved = await this.checkIfResolved(page);
      if (isResolved) {
        options.onStatusChange?.(
          `Live-Challenge (${detection.type ?? "unbekannt"}) im Browser erfolgreich gelöst!`,
          detection
        );
        return {
          handled: true,
          type: detection.type,
          resolved: true,
          durationMs: Date.now() - startTime
        };
      }

      // Re-attempt auto-interaction periodically (every 4 seconds) if still waiting
      if (Date.now() - lastInteractionTime > 4_000) {
        lastInteractionTime = Date.now();
        if (detection.type === "turnstile" && options.autoSolveTurnstile !== false) {
          await this.attemptTurnstileClick(page);
        } else if (detection.type === "shopify-checkpoint") {
          await this.attemptCheckpointSubmit(page);
        }
      }

      await this.sleep(pollIntervalMs);
    }

    return {
      handled: true,
      type: detection.type,
      resolved: false,
      durationMs: Date.now() - startTime,
      error: `Live-Challenge (${detection.type ?? "unbekannt"}) im Browser nicht innerhalb von ${Math.round(
        timeoutMs / 1000
      )}s gelöst (Timeout).`
    };
  }

  /**
   * Attempts to find and click the Cloudflare Turnstile verification checkbox.
   */
  async attemptTurnstileClick(page: Page): Promise<boolean> {
    if (page.isClosed()) return false;

    try {
      // 1. Try inside Turnstile iframe
      const frameLocator = page
        .frameLocator(
          'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="Turnstile" i], iframe[title*="Cloudflare" i]'
        )
        .first();

      const checkbox = frameLocator
        .locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, label, span.mark')
        .first();

      if (await checkbox.isVisible({ timeout: 1_200 }).catch(() => false)) {
        await checkbox.click({ timeout: 2_000 }).catch(() => undefined);
        return true;
      }

      // 2. Direct selector fallback on main document
      const directTarget = page.locator('.cf-turnstile input[type="checkbox"], #challenge-stage input').first();
      if (await directTarget.isVisible({ timeout: 800 }).catch(() => false)) {
        await directTarget.click({ timeout: 1_500 }).catch(() => undefined);
        return true;
      }
    } catch {
      // Ignore transient errors during frame attachment
    }

    return false;
  }

  /**
   * Submits a Shopify checkpoint form if a captcha token is already populated.
   */
  async attemptCheckpointSubmit(page: Page): Promise<boolean> {
    if (page.isClosed()) return false;

    try {
      const hasToken = await page
        .evaluate(() => {
          const cf = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value;
          const rc = document.querySelector<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]')?.value;
          const hc = document.querySelector<HTMLTextAreaElement>('textarea[name="h-captcha-response"]')?.value;
          return Boolean((cf && cf.trim()) || (rc && rc.trim()) || (hc && hc.trim()));
        })
        .catch(() => false);

      if (hasToken) {
        const submitButton = page
          .locator(
            'form[action*="/checkpoint"] button[type="submit"], form[action*="/checkpoint"] input[type="submit"], #checkpoint-submit, button#submit'
          )
          .first();

        if (await submitButton.isVisible({ timeout: 800 }).catch(() => false)) {
          await submitButton.click({ timeout: 1_500 }).catch(() => undefined);
          return true;
        }
      }
    } catch {
      // Ignore transient DOM evaluation errors
    }

    return false;
  }

  /**
   * Verifies whether the page has successfully progressed past the challenge/checkpoint.
   */
  async checkIfResolved(page: Page): Promise<boolean> {
    if (page.isClosed()) return false;

    const currentUrl = page.url();
    const isCheckpointUrl =
      currentUrl.includes("/checkpoint") || currentUrl.includes("/challenge") || currentUrl.includes("/throttle");

    if (!isCheckpointUrl) {
      // If we are no longer on a checkpoint URL, check whether challenge widgets remain
      const hasChallengeWidgets = await page
        .evaluate(() => {
          return Boolean(
            document.querySelector(
              'iframe[src*="challenges.cloudflare.com"], iframe[src*="google.com/recaptcha"], iframe[src*="hcaptcha.com"], .cf-turnstile, .g-recaptcha, .h-captcha'
            )
          );
        })
        .catch(() => false);

      if (!hasChallengeWidgets) {
        return true;
      }
    }

    // Check if checkout fields or confirmation elements have rendered
    const hasCheckoutFields = await page
      .evaluate(() => {
        return Boolean(
          document.querySelector(
            'input[name="email"], input[name="firstName"], input[name="address1"], #checkout_shipping_address, .step__sections, [data-step="contact_information"]'
          )
        );
      })
      .catch(() => false);

    return hasCheckoutFields;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton-Export für einfache Nutzung
export const defaultLiveChallengeHandler = new LiveChallengeHandler();

// Hilfsfunktion für direkten Aufruf
export async function handleChallenge(page: Page, options: LiveChallengeOptions = {}): Promise<LiveChallengeResult> {
  return defaultLiveChallengeHandler.handleLiveChallenge(page, options);
}
