import { observeCheckoutOutcome } from "../src/browser-worker/checkout-outcome-observer";

function page(url: string, title: string, body: string): any {
  return {
    url: () => url,
    title: async () => title,
    locator: () => ({ innerText: async () => body })
  };
}

describe("observeCheckoutOutcome", () => {
  it("accepts a strong thank-you URL", async () => {
    await expect(observeCheckoutOutcome(page("https://shop.test/checkout/thank_you", "", "")))
      .resolves.toEqual({ confirmed: true, source: "url" });
  });

  it("accepts explicit German order confirmation text", async () => {
    await expect(observeCheckoutOutcome(page("https://shop.test/checkout", "Bestellung", "Vielen Dank für Ihre Bestellung")))
      .resolves.toEqual({ confirmed: true, source: "text" });
  });

  it("does not treat the checkout page itself as success", async () => {
    await expect(observeCheckoutOutcome(page("https://shop.test/checkout", "Checkout", "Jetzt bezahlen")))
      .resolves.toEqual({ confirmed: false, source: "none" });
  });
});
