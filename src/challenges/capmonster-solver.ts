import {
  CapMonsterCloudClientFactory,
  ClientOptions,
  TurnstileRequest,
  RecaptchaV2Request,
} from "@zennolab_com/capmonstercloud-client";
import type { Page } from "patchright";

export class CapMonsterSolver {
  private client;

  constructor(apiKey: string) {
    this.client = CapMonsterCloudClientFactory.Create(
      new ClientOptions({ clientKey: apiKey })
    );
  }

  async solve(type: string, websiteUrl: string, websiteKey: string): Promise<string> {
    if (type === "turnstile" || type === "shopify-checkpoint") {
      const task = new TurnstileRequest({
        websiteURL: websiteUrl,
        websiteKey: websiteKey,
      });
      const result = await this.client.Solve(task);
      if (!result.solution?.token) {
        throw new Error("CapMonster hat kein Turnstile-Token zurückgegeben.");
      }
      return result.solution.token;
    }

    if (type === "recaptcha") {
      const task = new RecaptchaV2Request({
        websiteURL: websiteUrl,
        websiteKey: websiteKey,
      });
      const result = await this.client.Solve(task);
      const token = (result.solution as any)?.gRecaptchaResponse || (result.solution as any)?.token;
      if (!token) {
        throw new Error("CapMonster hat kein reCAPTCHA-Token zurückgegeben.");
      }
      return token;
    }

    throw new Error(`Nicht unterstützter Captcha-Typ für CapMonster: ${type}`);
  }

  async injectAndSubmit(page: Page, type: string, token: string): Promise<void> {
    await page.evaluate(({ type, token }) => {
      if (type === "turnstile" || type === "shopify-checkpoint") {
        const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement;
        if (input) {
          input.value = token;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (type === "recaptcha") {
        const input = document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement;
        if (input) {
          input.value = token;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      const form =
        document.querySelector("form#checkpoint-form") ||
        document.querySelector('form[action*="checkpoint"]') ||
        document.querySelector('form:has([name="cf-turnstile-response"])');

      if (form && form instanceof HTMLFormElement) {
        form.submit();
      }
    }, { type, token });

    const submitBtn = page.locator('form#checkpoint-form button[type="submit"], input[type="submit"]').first();
    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
    }
  }
}