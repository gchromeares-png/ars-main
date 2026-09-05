import { UnifiedInteractionPipeline, type ObservedSemanticField, type SemanticExecutionPlanItem } from "../src/browser-worker/unified-interaction-pipeline";

const field = (overrides: Partial<ObservedSemanticField>): ObservedSemanticField => ({
  fieldId: "field-0",
  index: 0,
  tagName: "input",
  inputType: "text",
  name: "",
  id: "",
  autocomplete: "",
  placeholder: "",
  ariaLabel: "",
  label: "",
  nearbyText: "",
  ...overrides
});

describe("UnifiedInteractionPipeline", () => {
  it("resolves SeleniumBase-observed fields and executes one semantic plan", async () => {
    const observed = [
      field({ fieldId: "email", index: 0, inputType: "email", autocomplete: "shipping email" }),
      field({ fieldId: "address", index: 1, autocomplete: "shipping address-line1" })
    ];
    let executed: SemanticExecutionPlanItem[] = [];
    const pipeline = new UnifiedInteractionPipeline({
      observeFields: async () => observed,
      executePlan: async plan => {
        executed = plan;
        return {
          planned: plan.length,
          applied: plan.length,
          verified: true,
          results: plan.map(item => ({ ...item, verified: true, observedValue: item.value })),
          fallbackNeeded: []
        };
      }
    });

    const result = await pipeline.autofill({
      "shipping:email": "student@example.test",
      "shipping:address1": "Teststraße 12"
    });

    expect(result.planned).toBe(2);
    expect(result.execution.verified).toBe(true);
    expect(executed.map(item => [item.fieldId, item.intent, item.context, item.value])).toEqual([
      ["email", "email", "shipping", "student@example.test"],
      ["address", "address1", "shipping", "Teststraße 12"]
    ]);
  });

  it("does not guess values for unknown or missing semantic targets", async () => {
    const pipeline = new UnifiedInteractionPipeline({
      observeFields: async () => [field({ fieldId: "mystery", name: "x" })],
      executePlan: async plan => ({ planned: plan.length, applied: 0, verified: true, results: [], fallbackNeeded: [] })
    });

    const result = await pipeline.autofill({ "unknown:email": "student@example.test" });
    expect(result.planned).toBe(0);
    expect(result.unresolved).toEqual([{ fieldId: "mystery", reason: "unknown-intent" }]);
  });
});
