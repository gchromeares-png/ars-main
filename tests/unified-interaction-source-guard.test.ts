import * as fs from "fs";
import * as path from "path";

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

describe("unified interaction architecture", () => {
  const pipeline = read("src/browser-worker/unified-interaction-pipeline.ts");
  const controller = read("src/electron/seleniumbase-profile-browser-controller.ts");
  const runtime = read("python/seleniumbase_cdp/semantic_interaction_runtime.py");
  const worker = read("python/seleniumbase_cdp/manual_profile_browser.py");

  it("keeps semantic resolution above the SeleniumBase execution boundary", () => {
    expect(pipeline).toContain("FieldSemanticResolver");
    expect(pipeline).toContain("executor.observeFields()");
    expect(pipeline).toContain("resolver.resolve(observed)");
    expect(pipeline).toContain("executor.executePlan(plan)");
    expect(controller).toContain("new UnifiedInteractionPipeline");
    expect(controller).toContain('"observe-semantic-fields"');
    expect(controller).toContain('"execute-semantic-plan"');
  });

  it("keeps execution SeleniumBase-owned and away from protected cores", () => {
    for (const source of [pipeline, controller, runtime, worker]) {
      expect(source).not.toContain("src/challenges");
      expect(source).not.toContain("checkout-payment-preparer");
    }
    expect(controller).toContain("SeleniumBaseProfileBrowserController");
    expect(runtime).toContain("data-ares-semantic-id");
    expect(runtime).toContain('"fallbackNeeded"');
    expect(worker).toContain("SeleniumBaseCdpAdapter");
  });
});
