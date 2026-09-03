import type { Locator } from "patchright";

export interface InteractionPoint {
  x: number;
  y: number;
}

export interface InteractionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InteractionTargetState {
  visible: boolean;
  enabled: boolean;
  stable: boolean;
  box?: InteractionBox;
}

export interface PointerInteractionProfile {
  /** Number of intermediate mouse points. */
  minSteps: number;
  maxSteps: number;
  /** Delay between generated pointer points. */
  minStepDelayMs: number;
  maxStepDelayMs: number;
  /** Keep the click away from the outer edge of the target. 0..0.45 */
  targetInsetRatio: number;
  /** Maximum offset around the target center as a ratio of the usable area. */
  targetVariationRatio: number;
}

export interface FormInteractionProfile {
  readinessTimeoutMs: number;
  verifyTimeoutMs: number;
}

export interface InteractionProfiles {
  pointer: PointerInteractionProfile;
  form: FormInteractionProfile;
}

export type InteractionOutcomeVerifier = () => boolean | Promise<boolean>;

export interface ClickInteractionOptions {
  seed?: number | string;
  attempts?: number;
  readinessTimeoutMs?: number;
  verifyTimeoutMs?: number;
  expected?: InteractionOutcomeVerifier;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface FillInteractionOptions {
  attempts?: number;
  readinessTimeoutMs?: number;
  verifyTimeoutMs?: number;
  expected?: InteractionOutcomeVerifier;
}

export interface InteractionAttemptResult {
  success: boolean;
  attempts: number;
  targetState: InteractionTargetState;
  targetPoint?: InteractionPoint;
}

export interface InteractionTarget {
  locator: Locator;
  name?: string;
}

export const DEFAULT_INTERACTION_PROFILES: InteractionProfiles = {
  pointer: {
    minSteps: 8,
    maxSteps: 18,
    minStepDelayMs: 2,
    maxStepDelayMs: 9,
    targetInsetRatio: 0.14,
    targetVariationRatio: 0.28
  },
  form: {
    readinessTimeoutMs: 4_000,
    verifyTimeoutMs: 1_500
  }
};
