import { normalizePaymentSessionInput } from "../src/payments/payment-session-normalizer";

describe("payment session IPC compatibility boundary", () => {
  it("maps profile/UI aliases into the established checkout session fields", () => {
    const pan = Array.from({ length: 16 }, () => "4").join("");
    const cvc = ["1", "2", "3"].join("");

    const session = normalizePaymentSessionInput({
      method: "card",
      card: {
        cardholderName: "Profile Holder",
        cardNumber: pan,
        expiryMonth: "12",
        expiryYear: "2030",
        cvc
      }
    });

    expect(session).toEqual({
      method: "card",
      label: undefined,
      card: {
        holderName: "Profile Holder",
        cardNumber: pan,
        expiry: "12/30",
        securityCode: cvc
      }
    });
    expect(session?.card).not.toHaveProperty("cardholderName");
    expect(session?.card).not.toHaveProperty("cvc");
  });

  it("keeps the existing checkout field names when they are supplied directly", () => {
    const session = normalizePaymentSessionInput({
      method: "card",
      card: {
        holderName: "Existing Holder",
        securityCode: "987",
        cardholderName: "UI Alias Holder",
        cvc: "123"
      }
    });

    expect(session?.card?.holderName).toBe("Existing Holder");
    expect(session?.card?.securityCode).toBe("987");
  });
});
