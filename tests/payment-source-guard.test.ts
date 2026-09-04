import * as fs from "fs";
import * as path from "path";

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

describe("payment source guard", () => {
  it("uses one established checkout card field contract end to end", () => {
    const models = source("src/payments/models.ts");
    const preparer = source("src/browser-worker/checkout-payment-preparer.ts");
    const vault = source("src/payments/profile-payment-vault.ts");
    const normalizer = source("src/payments/payment-session-normalizer.ts");
    const profileUi = source("src/app/profile-payment/profile-payment.component.ts");
    const profileHtml = source("src/app/profile-payment/profile-payment.component.html");
    const electronMain = source("src/electron/main.ts");

    expect(models).toContain("holderName?: string");
    expect(models).toContain("securityCode?: string");
    expect(models).not.toContain("cardholderName?: string");
    expect(models).not.toContain("cvc?: string");

    expect(preparer).toContain("card.holderName");
    expect(preparer).toContain("card.securityCode");
    expect(preparer).not.toContain("card.cardholderName");
    expect(preparer).not.toContain("card.cvc");

    for (const paymentSource of [vault, profileUi, profileHtml]) {
      expect(paymentSource).toContain("holderName");
      expect(paymentSource).toContain("securityCode");
      expect(paymentSource).not.toContain("cardholderName");
    }

    expect(normalizer).toContain('card["holderName"]');
    expect(normalizer).toContain('card["securityCode"]');
    expect(normalizer).not.toContain('card["cardholderName"]');
    expect(normalizer).not.toContain('card["cvc"]');
    expect(electronMain).toContain("normalizePaymentSessionInput(input)");
  });

  it("materializes split vault expiry at exactly one checkout boundary", () => {
    const vault = source("src/payments/profile-payment-vault.ts");
    const normalizer = source("src/payments/payment-session-normalizer.ts");
    const preparer = source("src/browser-worker/checkout-payment-preparer.ts");

    expect((vault.match(/materializeExpiry\(/g) ?? []).length).toBe(2); // declaration + one call
    expect(vault).toContain("expiry: materializeExpiry(secret.expiryMonth, secret.expiryYear)");
    expect(normalizer).not.toContain("expiryMonth");
    expect(normalizer).not.toContain("expiryYear");
    expect(preparer).not.toContain("expiryMonth");
    expect(preparer).not.toContain("expiryYear");
  });

  it("does not expose manual card inputs or a payment disable switch in task creation templates", () => {
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

  it("materializes the current profile payment preference at task start and propagates it to checkout children", () => {
    const service = source("src/app/services/electron.service.ts");
    const coordinator = source("src/monitor/auto-checkout-coordinator.ts");

    expect(service).toContain("await this.ensureProfilePaymentSession(taskId)");
    expect(service).toContain("profile?.paymentPreference");
    expect(service).toContain("this.setPaymentSession(taskId");
    expect(coordinator).not.toContain("paymentEnabled?: boolean");
    expect(coordinator).not.toMatch(/action\.paymentEnabled\s*\?/);
    expect(coordinator).toContain("this.options.getPaymentSession?.(parent.id)");
  });
});
