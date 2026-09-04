import { normalizePaymentSessionInput } from "../src/payments/payment-session-normalizer";

describe("payment session IPC boundary", () => {
  it("keeps the established checkout field names and combines split expiry", () => {
    const pan = Array.from({ length: 16 }, () => "4").join("");
    const securityCode = ["1", "2", "3"].join("");

    const session = normalizePaymentSessionInput({
      method: "card",
      card: {
        holderName: "Profile Holder",
        cardNumber: ` ${pan.slice(0, 8)} ${pan.slice(8)} `,
        expiryMonth: "12",
        expiryYear: "2030",
        securityCode
      }
    });

    expect(session).toEqual({
      method: "card",
      label: undefined,
      card: {
        holderName: "Profile Holder",
        cardNumber: pan,
        expiry: "12/30",
        securityCode
      }
    });
  });

  it("does not introduce alternate cardholderName/cvc runtime fields", () => {
    const session = normalizePaymentSessionInput({
      method: "card",
      card: {
        holderName: "Existing Holder",
        securityCode: "987",
        cardholderName: "Ignored Alias",
        cvc: "123"
      }
    });

    expect(session?.card?.holderName).toBe("Existing Holder");
    expect(session?.card?.securityCode).toBe("987");
    expect(session?.card).not.toHaveProperty("cardholderName");
    expect(session?.card).not.toHaveProperty("cvc");
  });
});
