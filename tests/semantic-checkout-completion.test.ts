import { evaluateSemanticCheckoutCompletion } from "../src/browser-worker/semantic-checkout-completion";
import { semanticTarget, targetKey, type FieldIntent } from "../src/browser-worker/semantic-target";

const required = new Set<Exclude<FieldIntent, "unknown">>([
  "email",
  "firstName",
  "lastName",
  "address1",
  "city",
  "postalCode"
]);

describe("evaluateSemanticCheckoutCompletion", () => {
  it("does not treat an empty normalized state as success", () => {
    const result = evaluateSemanticCheckoutCompletion({ filled: [], missing: [] }, required);

    expect(result.complete).toBe(false);
    expect(result.hasFilledRequiredTarget).toBe(false);
    expect(result.missingRequiredTargets).toEqual([]);
  });

  it("requires at least one filled required target and no missing required targets", () => {
    const shippingCity = semanticTarget("city", "shipping");
    const result = evaluateSemanticCheckoutCompletion({ filled: [shippingCity], missing: [] }, required);

    expect(result.complete).toBe(true);
    expect(result.hasFilledRequiredTarget).toBe(true);
  });

  it("keeps shipping and billing targets separate when deciding missing state", () => {
    const shippingCity = semanticTarget("city", "shipping");
    const billingCity = semanticTarget("city", "billing");
    const result = evaluateSemanticCheckoutCompletion({
      filled: [shippingCity],
      missing: [billingCity]
    }, required);

    expect(result.complete).toBe(false);
    expect(result.hasFilledRequiredTarget).toBe(true);
    expect(result.missingRequiredTargets.map(targetKey)).toEqual([targetKey(billingCity)]);
    expect(targetKey(shippingCity)).not.toBe(targetKey(billingCity));
  });

  it("ignores non-required missing targets", () => {
    const shippingCity = semanticTarget("city", "shipping");
    const shippingPhone = semanticTarget("phone", "shipping");
    const result = evaluateSemanticCheckoutCompletion({
      filled: [shippingCity],
      missing: [shippingPhone]
    }, required);

    expect(result.complete).toBe(true);
    expect(result.missingRequiredTargets).toEqual([]);
  });
});
