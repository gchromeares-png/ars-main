import type { Page } from "../../src/browser-worker/types";
import type { AresProfile } from "../../src/profiles/models";
import type { FieldSemanticResolver } from "../../src/browser-worker/field-semantic-resolver";
import { SemanticCheckoutProfilePlanner } from "../../src/browser-worker/semantic-checkout-profile-planner";
import { SemanticFieldAutofill } from "../../src/browser-worker/semantic-field-autofill";
import { evaluateSemanticCheckoutCompletion } from "../../src/browser-worker/semantic-checkout-completion";
import { GhostCursorUiInteractionHelper } from "../../src/browser-worker/ui-interaction-helper";
import { loadCheckoutFixtureStage } from "./fixture-loader";

export interface CheckoutFixtureRunResult {
  fixtureId: string;
  stageId: string;
  source: "synthetic" | "captured-dom";
  billingMode: "explicit-billing" | "same-as-shipping" | "separate-billing-fields";
  autofill: Awaited<ReturnType<SemanticFieldAutofill["result"]>>;
  completion: ReturnType<typeof evaluateSemanticCheckoutCompletion>;
}

/**
 * Runs a persisted fixture through the same Planner -> Resolver -> AutoFill ->
 * Completion chain used by checkout code. The runner contains no shop-specific
 * selectors or behavior.
 */
export async function runCheckoutFixtureStage(
  page: Page,
  manifestPath: string,
  profile: AresProfile,
  resolver: FieldSemanticResolver,
  stageId?: string
): Promise<CheckoutFixtureRunResult> {
  const fixture = loadCheckoutFixtureStage(manifestPath, stageId);
  const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fixture.html)}`;
  await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });

  const interactions = new GhostCursorUiInteractionHelper(page);
  const plan = await new SemanticCheckoutProfilePlanner(interactions).prepare(page, profile);
  const autofill = new SemanticFieldAutofill(page, interactions, resolver);

  await autofill.fillSemantic(plan.values);
  const result = await autofill.result(plan.values, fixture.requiredTargets);
  const completion = evaluateSemanticCheckoutCompletion({
    filled: result.filled,
    missing: result.missing,
    requiredTargets: fixture.requiredTargets
  });

  return {
    fixtureId: fixture.manifest.id,
    stageId: fixture.stage.id,
    source: fixture.manifest.source,
    billingMode: plan.billingMode,
    autofill: result,
    completion
  };
}
