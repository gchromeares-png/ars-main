import type { Locator } from "patchright";
import type { InteractionOutcomeExpectation, InteractionReadinessPolicy } from "./interaction-policies";

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
  minSteps: number;
  maxSteps: number;
  minStepDelayMs: number;
  maxStepDelayMs: number;
  targetInsetRatio: number;
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

export type InteractionFailureReason =
  | "not-ready"
  | "action-error"
  | "outcome-timeout";

export interface InteractionAttemptTrace {
  attempt: number;
  seed: string;
  readinessPolicy: string;
  targetState: InteractionTargetState;
  targetPoint?: InteractionPoint;
  outcomeExpectation?: string;
  failureReason?: InteractionFailureReason;
  error?: string;
}

export interface ClickInteractionOptions {
  seed?: number | string;
  attempts?: number;
  readinessTimeoutMs?: number;
  verifyTimeoutMs?: number;
  readiness?: InteractionReadinessPolicy;
  expected?: InteractionOutcomeExpectation;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface FillInteractionOptions {
  seed?: number | string;
  attempts?: number;
  readinessTimeoutMs?: number;
  verifyTimeoutMs?: number;
  readiness?: InteractionReadinessPolicy;
  expected?: InteractionOutcomeExpectation;
}

export interface InteractionAttemptResult {
  success: boolean;
  attempts: number;
  targetState: InteractionTargetState;
  targetPoint?: InteractionPoint;
  failureReason?: InteractionFailureReason;
  trace: InteractionAttemptTrace[];
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
