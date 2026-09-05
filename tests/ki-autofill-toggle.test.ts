import type { Page } from "../src/browser-worker/types";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { SemanticCheckoutProfilePlanner } from "../src/browser-worker/semantic-checkout-profile-planner";
import { toPersistedAresProfile, toProfileV2Draft } from "../src/profiles/profile-v2";

function explicitBillingProfile(kiAutofill: boolean) {
  const draft = toProfileV2Draft();
  draft.id = `ki-${kiAutofill}`;
  draft.name = "KI Toggle";
  draft.contact = { firstName: "Max", lastName: "Mustermann", email: "max@example.test" };
  draft.shippingAddress = {
    address1: "Mönckebergstraße 7",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE"
  };
  draft.billingSameAsShipping = false;
  draft.billingAddress = {
    address1: "Alexanderplatz 1",
    postalCode: "10178",
    city: "Berlin",
    countryCode: "DE"
  };
  draft.browser = { ...(draft.browser ?? {}), kiAutofill };
  return toPersistedAresProfile(draft);
}

describe("KI AutoFill profile switch", () => {
  it("carries the persisted profile preference into the checkout plan", async () => {
    const planner = new SemanticCheckoutProfilePlanner({} as any);

    const enabled = await planner.prepare({} as Page, explicitBillingProfile(true));
    const disabled = await planner.prepare({} as Page, explicitBillingProfile(false));

    expect(enabled.values.semanticAutofillEnabled).toBe(true);
    expect(disabled.values.semanticAutofillEnabled).toBe(false);
  });

  it("skips semantic resolver/DOM work when KI AutoFill is disabled", async () => {
    const resolve = jest.fn(() => {
      throw new Error("resolver must not run while KI AutoFill is disabled");
    });
    const autofill = new SemanticFieldAutofill(
      undefined as unknown as Page,
      undefined as any,
      { resolve } as any
    );

    await expect(autofill.fillSemantic({
      semanticAutofillEnabled: false,
      valueFor: () => "Hamburg"
    } as any)).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});
