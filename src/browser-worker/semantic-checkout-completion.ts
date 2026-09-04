import type { FieldIntent, SemanticTarget } from "./semantic-target";

export type RequiredFieldIntent = Exclude<FieldIntent, "unknown">;

export interface SemanticCompletionState {
  filled: SemanticTarget[];
  missing: SemanticTarget[];
}

export interface SemanticCheckoutCompletion {
  complete: boolean;
  hasFilledRequiredTarget: boolean;
  missingRequiredTargets: SemanticTarget[];
}

/**
 * Pure evaluation of an already-normalized semantic state. DOM visibility,
 * same-as-shipping handling, profile mapping and shop-specific decisions must
 * have happened before this function is called.
 */
export function evaluateSemanticCheckoutCompletion(
  result: SemanticCompletionState,
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
