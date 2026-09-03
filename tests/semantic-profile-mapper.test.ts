import type { AresProfile } from "../src/profiles/models";
import { SemanticProfileMapper } from "../src/browser-worker/semantic-profile-mapper";
import { semanticTarget, targetKey } from "../src/browser-worker/semantic-target";

function profile(overrides: Partial<AresProfile> = {}): AresProfile {
  return {
    id: "profile-1",
    name: "Test",
    contact: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      phone: "+491234"
    },
    address: {
      address1: "Defaultweg 1",
      postalCode: "28195",
      city: "Bremen",
      countryCode: "DE"
    },
    shippingAddress: {
      address1: "Hafenstraße 2",
      street: "Hafenstraße",
      houseNumber: "2",
      postalCode: "20095",
      city: "Hamburg",
      countryCode: "DE"
    },
    ...overrides
  };
}

describe("SemanticProfileMapper", () => {
  it("keeps default, shipping and explicit billing value sources separate", () => {
    const mapper = new SemanticProfileMapper(profile({
      billingAddress: {
        address1: "Rechnungsweg 7",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE"
      }
    }));

    expect(mapper.valueFor(semanticTarget("city", "unknown"))).toBe("Bremen");
    expect(mapper.valueFor(semanticTarget("city", "shipping"))).toBe("Hamburg");
    expect(mapper.valueFor(semanticTarget("city", "billing"))).toBe("Berlin");
  });

  it("does not reinterpret unknown context as shipping or billing", () => {
    const mapper = new SemanticProfileMapper(profile());

    expect(mapper.valueFor(semanticTarget("postalCode", "unknown"))).toBe("28195");
    expect(mapper.valueFor(semanticTarget("postalCode", "shipping"))).toBe("20095");
  });

  it("prefers same-as-shipping by leaving billing fields missing when no billing address exists", () => {
    const mapper = new SemanticProfileMapper(profile(), { billingMode: "prefer-same-as-shipping" });

    expect(mapper.valueFor(semanticTarget("city", "billing"))).toBeUndefined();
    expect(mapper.valueFor(semanticTarget("postalCode", "billing"))).toBeUndefined();
  });

  it("can materialize separate billing targets from shipping values without collapsing identity", () => {
    const mapper = new SemanticProfileMapper(profile(), { billingMode: "separate-billing-fields" });
    const shippingCity = semanticTarget("city", "shipping");
    const billingCity = semanticTarget("city", "billing");
    const shippingPostalCode = semanticTarget("postalCode", "shipping");
    const billingPostalCode = semanticTarget("postalCode", "billing");

    expect(mapper.valueFor(shippingCity)).toBe("Hamburg");
    expect(mapper.valueFor(billingCity)).toBe("Hamburg");
    expect(mapper.valueFor(shippingPostalCode)).toBe("20095");
    expect(mapper.valueFor(billingPostalCode)).toBe("20095");

    expect(targetKey(shippingCity)).not.toBe(targetKey(billingCity));
    expect(targetKey(shippingPostalCode)).not.toBe(targetKey(billingPostalCode));
  });

  it("returns missing when the selected source has no matching field value", () => {
    const mapper = new SemanticProfileMapper(profile(), { billingMode: "separate-billing-fields" });

    expect(mapper.valueFor(semanticTarget("address2", "shipping"))).toBeUndefined();
    expect(mapper.valueFor(semanticTarget("address2", "billing"))).toBeUndefined();
  });
});