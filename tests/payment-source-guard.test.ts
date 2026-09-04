import * as fs from "fs";
import * as path from "path";

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

describe("payment source guard", () => {
  it("keeps the established checkout card class and maps profile aliases at boundaries", () => {
    const models = source("src/payments/models.ts");
    const preparer = source("src/browser-worker/checkout-payment-preparer.ts");
    const vault = source("src/payments/profile-payment-vault.ts");
    const normalizer = source("src/payments/payment-session-normalizer.ts");
    const electronMain = source("src/electron/main.ts");

    expect(models).toContain("holderName?: string");
    expect(models).toContain("securityCode?: string");
    expect(models).not.toContain("cardholderName?: string");
    expect(models).not.toContain("cvc?: string");

    expect(preparer).toContain("card.holderName");
    expect(preparer).toContain("card.securityCode");
    expect(preparer).not.toContain("card.cardholderName");
    expect(preparer).not.toContain("card.cvc");

    expect(vault).toContain("cardholderName");
    expect(vault).toContain("cvc");
    expect(vault).toContain("holderName: secret.cardholderName");
    expect(vault).toContain("securityCode: secret.cvc");

    expect(normalizer).toContain('card["cardholderName"]');
    expect(normalizer).toContain('card["cvc"]');
    expect(normalizer).toContain("holderName:");
    expect(normalizer).toContain("securityCode:");
    expect(electronMain).toContain("normalizePaymentSessionInput(input)");
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
