import { PokemonCenterReleaseJourney } from "../src/commerce/pokemon-center/release-journey";

function fakePage(buttonText: string) {
  const candidate = {
    isVisible: jest.fn().mockResolvedValue(true),
    isEnabled: jest.fn().mockResolvedValue(true),
    evaluate: jest.fn().mockResolvedValue(buttonText),
    click: jest.fn().mockResolvedValue(undefined)
  };
  const candidates = {
    count: jest.fn().mockResolvedValue(1),
    nth: jest.fn().mockReturnValue(candidate)
  };
  const page = {
    locator: jest.fn().mockReturnValue(candidates),
    waitForLoadState: jest.fn().mockResolvedValue(undefined)
  };
  return { page: page as any, candidate };
}

const shop = {
  id: "pokemon-center-de",
  name: "Pokemon Center DE",
  baseUrl: "https://www.pokemoncenter.com/de-de",
  platform: "custom" as const,
  config: {}
};

describe("PokemonCenterReleaseJourney final purchase guard", () => {
  it("does not click the final purchase button when backend permission is false", async () => {
    const journey = new PokemonCenterReleaseJourney();
    const { page, candidate } = fakePage("Zahlungspflichtig bestellen");

    const result = await journey.submitOrder(page, shop, () => false);

    expect(result).toBe(false);
    expect(candidate.click).not.toHaveBeenCalled();
  });

  it("clicks only after the backend guard returns true immediately before submit", async () => {
    const journey = new PokemonCenterReleaseJourney();
    const { page, candidate } = fakePage("Place order");
    const guard = jest.fn().mockReturnValue(true);

    const result = await journey.submitOrder(page, shop, guard);

    expect(result).toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(candidate.click).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated buttons even when global purchase permission is enabled", async () => {
    const journey = new PokemonCenterReleaseJourney();
    const { page, candidate } = fakePage("Weiter zur Zahlung");
    const guard = jest.fn().mockReturnValue(true);

    const result = await journey.submitOrder(page, shop, guard);

    expect(result).toBe(false);
    expect(guard).not.toHaveBeenCalled();
    expect(candidate.click).not.toHaveBeenCalled();
  });
});
