import { evaluateSemanticCheckoutCompletion } from "../src/browser-worker/semantic-checkout-completion";
import { semanticTarget, targetKey } from "../src/browser-worker/semantic-target";

describe("evaluateSemanticCheckoutCompletion", () => {
  it("does not treat an empty normalized state as success", () => {
    const result = evaluateSemanticCheckoutCompletion({
      filled: [],
      missing: [],
      requiredTargets: []
    });

    expect(result.complete).toBe(false);
    expect(result.hasFilledRequiredTarget).toBe(false);
    expect(result.missingRequiredTargets).toEqual([]);
  });

  it("requires concrete required targets to be filled", () => {
    const shippingCity = semanticTarget("city", "shipping");
    const result = evaluateSemanticCheckoutCompletion({
      filled: [shippingCity],
      missing: [],
      requiredTargets: [shippingCity]
    });

    expect(result.complete).toBe(true);
    expect(result.hasFilledRequiredTarget).toBe(true);
  });

  it("keeps shipping and billing targets separate even for the same intent", () => {
    const shippingCity = semanticTarget("city", "shipping");
    const billingCity = semanticTarget("city", "billing");
    const result = evaluateSemanticCheckoutCompletion({
      filled: [shippingCity],
      missing: [billingCity],
      requiredTargets: [shippingCity, billingCity]
    });

    expect(result.complete).toBe(false);
    expect(result.hasFilledRequiredTarget).toBe(true);
    expect(result.missingRequiredTargets.map(targetKey)).toEqual([targetKey(billingCity)]);
    expect(targetKey(shippingCity)).not.toBe(targetKey(billingCity));
  });

  it("treats a required target absent from both filled and missing as incomplete", () => {
    const shippingCity = semanticTarget("city", "shipping");
    const billingCity = semanticTarget("city", "billing");
    const result = evaluateSemanticCheckoutCompletion({
      filled: [shippingCity],
      missing: [],
      requiredTargets: [shippingCity, billingCity]
    });

    expect(result.complete).toBe(false);
    expect(result.missingRequiredTargets.map(targetKey)).toEqual([targetKey(billingCity)]);
  });

  it("ignores non-required missing targets", () => {
    const shippingCity = semanticTarget("city", "shipping");
    const shippingPhone = semanticTarget("phone", "shipping");
    const result = evaluateSemanticCheckoutCompletion({
      filled: [shippingCity],
      missing: [shippingPhone],
      requiredTargets: [shippingCity]
    });

    expect(result.complete).toBe(true);
    expect(result.missingRequiredTargets).toEqual([]);
  });
});
