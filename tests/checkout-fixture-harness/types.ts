import type { AddressContext, FieldIntent, SemanticTarget } from "../../src/browser-worker/semantic-target";

export type CheckoutFixtureSource = "synthetic" | "captured-dom";

export interface CheckoutFixtureCaptureMetadata {
  sourceLabel: string;
  capturedAt: string;
  sanitizerVersion: 1;
  sanitized: true;
}

export interface CheckoutFixtureStage {
  id: string;
  htmlFile: string;
  requiredTargets: Array<{
    intent: Exclude<FieldIntent, "unknown">;
    context: AddressContext;
  }>;
}

export interface CheckoutFixtureManifest {
  schemaVersion: 1;
  id: string;
  source: CheckoutFixtureSource;
  description?: string;
  capture?: CheckoutFixtureCaptureMetadata;
  stages: CheckoutFixtureStage[];
}

export interface CheckoutFixtureLoadedStage {
  manifest: CheckoutFixtureManifest;
  stage: CheckoutFixtureStage;
  html: string;
  requiredTargets: SemanticTarget[];
}
