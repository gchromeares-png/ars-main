import { normalizePaymentSessionInput } from "../src/payments/payment-session-normalizer";

describe("payment session IPC compatibility boundary", () => {
  it("rewrites legacy card aliases to canonical names immediately", () => {
    const pan = Array.from({ length: 16 }, () => "4").join("");
    const legacyCvc = ["1", "2", "3"].join("");

    const session = normalizePaymentSessionInput({
      method: "card",
      card: {
        holderName: "Legacy Holder",
        cardNumber: pan,
        expiry: "12/30",
        securityCode: legacyCvc
      }
    });

    expect(session).toEqual({
      method: "card",
      label: undefined,
      card: {
        cardholderName: "Legacy Holder",
        cardNumber: pan,
        expiryMonth: undefined,
        expiryYear: undefined,
        expiry: "12/30",
        cvc: legacyCvc
      }
    });
    expect(session?.card).not.toHaveProperty("holderName");
    expect(session?.card).not.toHaveProperty("securityCode");
  });

  it("prefers canonical fields when canonical and legacy values are both supplied", () => {
    const session = normalizePaymentSessionInput({
      method: "card",
      card: {
        cardholderName: "Canonical Holder",
        holderName: "Legacy Holder",
        cvc: "987",
        securityCode: "123"
      }
    });

    expect(session?.card?.cardholderName).toBe("Canonical Holder");
    expect(session?.card?.cvc).toBe("987");
  });
});
