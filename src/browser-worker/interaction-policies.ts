import type { Locator, Page } from "patchright";
import type { InteractionTargetState } from "./interaction-models";

export interface InteractionReadinessPolicy {
  name: string;
  evaluate(locator: Locator, state: InteractionTargetState): boolean | Promise<boolean>;
}

export interface InteractionOutcomeExpectation {
  name: string;
  verify(page: Page): boolean | Promise<boolean>;
}

export const DEFAULT_READINESS_POLICY: InteractionReadinessPolicy = {
  name: "visible-enabled-stable",
  evaluate: (_locator, state) => state.visible && state.enabled && state.stable && Boolean(state.box)
};

export function locatorValueEquals(locator: Locator, expected: string): InteractionOutcomeExpectation {
  return {
    name: "locator-value-equals",
    verify: async () => (await locator.inputValue().catch(() => "")) === expected
  };
}

export function locatorFocused(locator: Locator): InteractionOutcomeExpectation {
  return {
    name: "locator-focused",
    verify: async () => locator.evaluate(element => element === document.activeElement).catch(() => false)
  };
}

export function locatorVisible(locator: Locator): InteractionOutcomeExpectation {
  return {
    name: "locator-visible",
    verify: async () => locator.isVisible().catch(() => false)
  };
}

export function urlMatches(pattern: RegExp): InteractionOutcomeExpectation {
  return {
    name: "url-matches",
    verify: page => pattern.test(page.url())
  };
}
