import * as fs from "fs";
import * as path from "path";
import { semanticTarget } from "../../src/browser-worker/semantic-target";
import { assertSanitizedCapturedDom } from "./sanitize-captured-dom";
import type {
  CheckoutFixtureLoadedStage,
  CheckoutFixtureManifest,
  CheckoutFixtureStage
} from "./types";

function readManifest(manifestPath: string): CheckoutFixtureManifest {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as CheckoutFixtureManifest;
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported checkout fixture schema: ${parsed.schemaVersion}`);
  if (!parsed.id?.trim()) throw new Error("Checkout fixture manifest is missing id.");
  if (parsed.source !== "synthetic" && parsed.source !== "captured-dom") {
    throw new Error(`Unsupported checkout fixture source: ${String(parsed.source)}`);
  }
  if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) {
    throw new Error(`Checkout fixture ${parsed.id} has no stages.`);
  }

  if (parsed.source === "captured-dom") {
    const capture = parsed.capture;
    if (!capture || capture.sanitized !== true || capture.sanitizerVersion !== 1) {
      throw new Error(`Captured DOM fixture ${parsed.id} is missing sanitization metadata.`);
    }
  }

  return parsed;
}

function selectStage(manifest: CheckoutFixtureManifest, stageId?: string): CheckoutFixtureStage {
  const stage = stageId
    ? manifest.stages.find(candidate => candidate.id === stageId)
    : manifest.stages[0];
  if (!stage) throw new Error(`Checkout fixture ${manifest.id} has no stage '${stageId ?? "<first>"}'.`);
  if (!stage.htmlFile?.trim()) throw new Error(`Checkout fixture ${manifest.id}/${stage.id} is missing htmlFile.`);
  return stage;
}

export function loadCheckoutFixtureStage(
  manifestPath: string,
  stageId?: string
): CheckoutFixtureLoadedStage {
  const manifest = readManifest(manifestPath);
  const stage = selectStage(manifest, stageId);
  const htmlPath = path.resolve(path.dirname(manifestPath), stage.htmlFile);
  const html = fs.readFileSync(htmlPath, "utf8");

  if (manifest.source === "captured-dom") assertSanitizedCapturedDom(html);

  return {
    manifest,
    stage,
    html,
    requiredTargets: stage.requiredTargets.map(target => semanticTarget(target.intent, target.context))
  };
}
