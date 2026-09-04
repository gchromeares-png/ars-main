import type { SemanticAutofillResult } from "./semantic-field-autofill";
import type { FieldIntent, SemanticTarget } from "./semantic-target";

export type RequiredFieldIntent = Exclude<FieldIntent, "unknown">;

export interface SemanticCheckoutCompletion {
  complete: boolean;
  hasFilledRequiredTarget: boolean;
  missingRequiredTargets: SemanticTarget[];
}

/**
 * A checkout profile is only considered sufficiently filled when at least one
 * required semantic target was actually completed and no observed required
 * target is still missing. Context remains part of every concrete target.
 */
export function evaluateSemanticCheckoutCompletion(
  result: Pick<SemanticAutofillResult, "filled" | "missing">,
  requiredIntents: ReadonlySet<RequiredFieldIntent>
): SemanticCheckoutCompletion {
  const isRequired = (target: SemanticTarget): target is SemanticTarget & { intent: RequiredFieldIntent } =>
    target.intent !== "unknown" && requiredIntents.has(target.intent as RequiredFieldIntent);

  const hasFilledRequiredTarget = result.filled.some(isRequired);
  const missingRequiredTargets = result.missing.filter(isRequired).map(target => ({ ...target }));

  return {
    complete: hasFilledRequiredTarget && missingRequiredTargets.length === 0,
    hasFilledRequiredTarget,
    missingRequiredTargets
  };
}
