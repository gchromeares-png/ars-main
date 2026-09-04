import { normalizePaymentSessionInput } from "../src/payments/payment-session-normalizer";

describe("payment session IPC boundary", () => {
  it("keeps the established checkout card fields unchanged", () => {
    const pan = Array.from({ length: 16 }, () => "4").join("");
    const securityCode = ["1", "2", "3"].join("");

    const session = normalizePaymentSessionInput({
      method: "card",
      card: {
        holderName: "Profile Holder",
        cardNumber: ` ${pan.slice(0, 8)} ${pan.slice(8)} `,
        expiry: "12/30",
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

  it("does not derive checkout expiry from vault-only split expiry fields", () => {
    const session = normalizePaymentSessionInput({
      method: "card",
      card: {
        holderName: "Existing Holder",
        cardNumber: "4444444444444444",
        expiryMonth: "12",
        expiryYear: "2030",
        securityCode: "987"
      }
    });

    expect(session?.card?.expiry).toBeUndefined();
    expect(session?.card?.holderName).toBe("Existing Holder");
    expect(session?.card?.securityCode).toBe("987");
  });
});
