import { evaluatePaymentReadiness } from "../src/browser-worker/payment-readiness";
import type { CheckoutPaymentSession, PaymentPreparationResult } from "../src/payments/models";

const session: CheckoutPaymentSession = {
  method: "card",
  card: {
    holderName: "Test Holder",
    cardNumber: "4111111111111111",
    expiry: "12/30",
    securityCode: "123"
  }
};

const prepared: PaymentPreparationResult = {
  detectedMethods: ["card"],
  selectedMethod: "card",
  filledFields: ["holderName", "cardNumber", "expiry", "securityCode"],
  missingFields: [],
  requiresUserAction: false
};

describe("evaluatePaymentReadiness", () => {
  it("accepts a fully prepared ephemeral card session", () => {
    expect(evaluatePaymentReadiness(session, prepared)).toEqual({ ready: true, reason: "ready" });
  });

  it("fails closed without an ephemeral payment session", () => {
    expect(evaluatePaymentReadiness(undefined, prepared)).toEqual({ ready: false, reason: "missing-session" });
  });

  it("fails closed when required card data is missing", () => {
    const incomplete: CheckoutPaymentSession = {
      method: "card",
      card: { cardNumber: "4111111111111111", expiry: "12/30" }
    };
    expect(evaluatePaymentReadiness(incomplete, prepared)).toEqual({ ready: false, reason: "missing-card-data" });
  });

  it("fails closed when checkout preparation reports a missing field", () => {
    expect(evaluatePaymentReadiness(session, {
      ...prepared,
      missingFields: ["securityCode"],
      filledFields: ["cardNumber", "expiry"]
    })).toEqual({ ready: false, reason: "missing-card-fields" });
  });
});
