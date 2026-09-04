import * as fs from "fs";
import * as path from "path";

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

describe("payment canonical source guard", () => {
  it("keeps legacy aliases out of domain/runtime/UI code", () => {
    const canonicalOnlyFiles = [
      "src/payments/models.ts",
      "src/payments/ephemeral-payment-executor.ts",
      "src/browser-worker/checkout-payment-preparer.ts",
      "src/app/app.component.ts",
      "src/app/drop-setups/drop-setups.component.ts",
      "src/app/drop-setups/drop-setups.component.html"
    ];

    for (const file of canonicalOnlyFiles) {
      const text = source(file);
      expect(text).not.toMatch(/\bholderName\b/);
      expect(text).not.toMatch(/\bsecurityCode\b/);
    }
  });

  it("accepts legacy aliases only in the dedicated IPC normalization boundary", () => {
    const normalizer = source("src/payments/payment-session-normalizer.ts");
    const electronMain = source("src/electron/main.ts");

    expect(normalizer).toContain('card["holderName"]');
    expect(normalizer).toContain('card["securityCode"]');
    expect(normalizer).toContain("cardholderName:");
    expect(normalizer).toContain("cvc:");
    expect(electronMain).toContain("normalizePaymentSessionInput(input)");
  });

  it("does not expose manual card inputs or a payment disable switch in task creation surfaces", () => {
    const appHtml = source("src/app/app.component.html");
    const dropHtml = source("src/app/drop-setups/drop-setups.component.html");

    for (const html of [appHtml, dropHtml]) {
      expect(html).not.toContain("sessionCardHolderName");
      expect(html).not.toContain("sessionCardNumber");
      expect(html).not.toContain("sessionCardExpiry");
      expect(html).not.toContain("sessionCardSecurityCode");
      expect(html).not.toContain("taskPaymentEnabled");
      expect(html).not.toContain("sessionPaymentEnabled");
      expect(html).not.toContain("manuell im Checkout");
    }
  });

  it("materializes the current profile payment preference at task start and always propagates it to checkout children", () => {
    const service = source("src/app/services/electron.service.ts");
    const coordinator = source("src/monitor/auto-checkout-coordinator.ts");

    expect(service).toContain("await this.ensureProfilePaymentSession(taskId)");
    expect(service).toContain("profile?.paymentPreference");
    expect(service).toContain("this.setPaymentSession(taskId");
    expect(coordinator).not.toMatch(/action\.paymentEnabled\s*\?/);
    expect(coordinator).toContain("this.options.getPaymentSession?.(parent.id)");
  });
});
