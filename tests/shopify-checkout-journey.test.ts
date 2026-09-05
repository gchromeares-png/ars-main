import { ShopifyCheckoutJourney } from "../src/shopify/checkout-journey";

function fakePage(labels: string[]) {
  const candidates = labels.map(label => ({
    isVisible: jest.fn().mockResolvedValue(true),
    isEnabled: jest.fn().mockResolvedValue(true),
    evaluate: jest.fn().mockResolvedValue(label),
    innerText: jest.fn().mockResolvedValue(label),
    click: jest.fn().mockResolvedValue(undefined)
  }));
  const collection = {
    count: jest.fn().mockResolvedValue(candidates.length),
    nth: jest.fn((index: number) => candidates[index])
  };
  const page = {
    locator: jest.fn().mockReturnValue(collection),
    waitForLoadState: jest.fn().mockResolvedValue(undefined)
  };
  return { page: page as any, candidates };
}

describe("ShopifyCheckoutJourney", () => {
  it("detects a final order control without clicking it", async () => {
    const journey = new ShopifyCheckoutJourney();
    const { page, candidates } = fakePage(["Pay now"]);

    await expect(journey.isReadyForFinalSubmit(page)).resolves.toBe(true);
    expect(candidates[0].click).not.toHaveBeenCalled();
  });

  it("advances only through explicit non-final checkout controls", async () => {
    const journey = new ShopifyCheckoutJourney();
    const { page, candidates } = fakePage(["Pay now", "Continue to payment"]);

    await expect(journey.advanceCheckout(page)).resolves.toBe(true);
    expect(candidates[0].click).not.toHaveBeenCalled();
    expect(candidates[1].click).toHaveBeenCalledTimes(1);
  });

  it("keeps final purchase blocked until the backend guard is true", async () => {
    const journey = new ShopifyCheckoutJourney();
    const { page, candidates } = fakePage(["Zahlungspflichtig bestellen"]);

    await expect(journey.submitOrder(page, () => false)).resolves.toBe(false);
    expect(candidates[0].click).not.toHaveBeenCalled();

    const guard = jest.fn().mockReturnValue(true);
    await expect(journey.submitOrder(page, guard)).resolves.toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(candidates[0].click).toHaveBeenCalledTimes(1);
  });

  it("never treats a checkout continuation as a final purchase", async () => {
    const journey = new ShopifyCheckoutJourney();
    const { page, candidates } = fakePage(["Weiter zur Zahlung"]);
    const guard = jest.fn().mockReturnValue(true);

    await expect(journey.submitOrder(page, guard)).resolves.toBe(false);
    expect(guard).not.toHaveBeenCalled();
    expect(candidates[0].click).not.toHaveBeenCalled();
  });
});
