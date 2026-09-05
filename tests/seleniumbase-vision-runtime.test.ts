import * as fs from "fs";
import * as path from "path";

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

describe("SeleniumBase vision runtime E2E wiring", () => {
  const classifier = read("python/seleniumbase_cdp/vision_grid_classifier.py");
  const bootstrap = read("python/seleniumbase_cdp/vision_runtime_bootstrap.py");
  const electronRuntime = read("src/electron/seleniumbase-vision-runtime.ts");
  const profileController = read("src/electron/profile-browser-controller.ts");
  const preload = read("src/electron/preload.ts");
  const pkg = JSON.parse(read("package.json"));

  it("batches grid inference and uses CUDA when available", () => {
    expect(classifier).toContain('self._device = "cuda" if torch.cuda.is_available() else "cpu"');
    expect(classifier).toContain("images=[image for _, image in loaded]");
    expect(classifier).toContain("torch.inference_mode");
    expect(classifier).toContain("outputs.logits_per_image.float()");
    expect(classifier).toContain('"device": self._device');
  });

  it("prepares dependencies and caches the configured vision model", () => {
    expect(bootstrap).toContain('REQUIREMENTS = ROOT / "requirements-seleniumbase-vision.txt"');
    expect(bootstrap).toContain('"-m",');
    expect(bootstrap).toContain('"pip",');
    expect(bootstrap).toContain("AutoProcessor.from_pretrained(model_name");
    expect(bootstrap).toContain("AutoModel.from_pretrained(model_name");
    expect(bootstrap).toContain("torch.cuda.is_available()");
  });

  it("makes vision preparation part of the normal ARES profile-browser start", () => {
    expect(profileController).toContain("private readonly visionRuntime = new SeleniumBaseVisionRuntime()");
    const prepare = profileController.indexOf("await this.visionRuntime.prepare()");
    const browserOpen = profileController.indexOf("return this.seleniumBase.open(");
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(browserOpen).toBeGreaterThan(prepare);
    expect(profileController).toContain('ipcMain.handle("get-seleniumbase-vision-status"');
    expect(profileController).toContain('ipcMain.handle("prepare-seleniumbase-vision"');
  });

  it("exposes diagnostics and one-command preparation without adding a browser engine", () => {
    expect(preload).toContain("getSeleniumBaseVisionStatus");
    expect(preload).toContain("prepareSeleniumBaseVision");
    expect(pkg.scripts["vision:status"]).toContain("vision_runtime_bootstrap.py --status");
    expect(pkg.scripts["vision:prepare"]).toContain("vision_runtime_bootstrap.py --prepare");
    expect(electronRuntime.toLowerCase()).not.toContain("playwright");
    expect(electronRuntime.toLowerCase()).not.toContain("patchright");
    expect(bootstrap.toLowerCase()).not.toContain("playwright");
    expect(bootstrap.toLowerCase()).not.toContain("patchright");
  });
});
