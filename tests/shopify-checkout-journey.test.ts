import { ShopifyCheckoutJourney } from "../src/shopify/checkout-journey";

function fakePage(labels: string[]) {
  const candidates = labels.map((label, index) => ({
    isVisible: jest.fn().mockResolvedValue(true),
    isEnabled: jest.fn().mockResolvedValue(true),
    evaluate: jest.fn().mockResolvedValue(label),
    innerText: jest.fn().mockResolvedValue(label),
    scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
    boundingBox: jest.fn().mockResolvedValue({ x: 120 + index * 110, y: 160, width: 90, height: 36 }),
    click: jest.fn().mockResolvedValue(undefined)
  }));
  const collection = {
    count: jest.fn().mockResolvedValue(candidates.length),
    nth: jest.fn((index: number) => candidates[index])
  };
  const mouse = {
    move: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined)
  };
  const page = {
    interactionSeed: "shopify-checkout-test-task",
    locator: jest.fn().mockReturnValue(collection),
    waitForLoadState: jest.fn().mockResolvedValue(undefined),
    mouse
  };
  return { page: page as any, candidates, mouse };
}

describe("ShopifyCheckoutJourney", () => {
  it("detects a final order control without clicking it", async () => {
    const journey = new ShopifyCheckoutJourney();
    const { page, mouse } = fakePage(["Pay now"]);

    await expect(journey.isReadyForFinalSubmit(page)).resolves.toBe(true);
    expect(mouse.click).not.toHaveBeenCalled();
  });

  it("advances only through explicit non-final checkout controls", async () => {
    const journey = new ShopifyCheckoutJourney();
    const { page, candidates, mouse } = fakePage(["Pay now", "Continue to payment"]);

    await expect(journey.advanceCheckout(page)).resolves.toBe(true);
    expect(candidates[0].click).not.toHaveBeenCalled();
    expect(candidates[1].click).not.toHaveBeenCalled();
    expect(mouse.click).toHaveBeenCalledTimes(1);
  });

  it("keeps final purchase blocked until the backend guard is true", async () => {
    const journey = new ShopifyCheckoutJourney();
    const { page, mouse } = fakePage(["Zahlungspflichtig bestellen"]);

    await expect(journey.submitOrder(page, () => false)).resolves.toBe(false);
    expect(mouse.click).not.toHaveBeenCalled();

    const guard = jest.fn().mockReturnValue(true);
    await expect(journey.submitOrder(page, guard)).resolves.toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(mouse.click).toHaveBeenCalledTimes(1);
  });

  it("never treats a checkout continuation as a final purchase", async () => {
    const journey = new ShopifyCheckoutJourney();
    const { page, mouse } = fakePage(["Weiter zur Zahlung"]);
    const guard = jest.fn().mockReturnValue(true);

    await expect(journey.submitOrder(page, guard)).resolves.toBe(false);
    expect(guard).not.toHaveBeenCalled();
    expect(mouse.click).not.toHaveBeenCalled();
  });
});
