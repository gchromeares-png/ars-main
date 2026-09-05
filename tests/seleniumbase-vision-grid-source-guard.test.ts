import * as fs from "fs";
import * as path from "path";

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

describe("SeleniumBase vision grid guard", () => {
  const adapter = read("python/seleniumbase_cdp/seleniumbase_adapter.py");
  const worker = read("python/seleniumbase_cdp/manual_profile_browser.py");
  const runner = read("python/seleniumbase_cdp/vision_grid_runner.py");
  const classifier = read("python/seleniumbase_cdp/vision_grid_classifier.py");
  const baseRequirements = read("requirements-seleniumbase-cdp.txt");
  const visionRequirements = read("requirements-vision-grid.txt");

  it("keeps ML optional and SeleniumBase-only", () => {
    expect(baseRequirements).not.toContain("torch");
    expect(visionRequirements).toContain("torch==2.8.0");
    expect(adapter).toContain("from vision_grid_classifier import VisionGridClassifier");
    expect(adapter.indexOf("from vision_grid_classifier import VisionGridClassifier")).toBeGreaterThan(adapter.indexOf("def _build_vision_runner"));
    expect(adapter).toContain("await_promise=True");
    for (const source of [adapter, worker, runner, classifier]) {
      expect(source.toLowerCase()).not.toContain("playwright");
      expect(source.toLowerCase()).not.toContain("patchright");
      expect(source).not.toContain("src/challenges");
    }
  });

  it("runs only on new structural grid signatures and reuses the action layer", () => {
    expect(runner).toContain("signature == self._last_signature");
    expect(runner).toContain("execute_async_script");
    expect(runner).toContain("apply_grid_selection");
    expect(worker).toContain('VISION_FILENAME = ".ares-vision.json"');
    expect(worker).toContain("vision_config=_vision_config(command, profile_dir) if authorized_test_mode else {}");
    expect(classifier).not.toContain("2captcha.com");
  });
});
