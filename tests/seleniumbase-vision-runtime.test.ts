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

  it("starts optional vision preparation without blocking the normal ARES profile browser", () => {
    const openStart = profileController.indexOf("async open(");
    const openEnd = profileController.indexOf("\n  captureCookies(", openStart);
    expect(openStart).toBeGreaterThanOrEqual(0);
    expect(openEnd).toBeGreaterThan(openStart);
    const openMethod = profileController.slice(openStart, openEnd);
    const prepare = openMethod.indexOf("void this.visionRuntime.prepare().catch(() => undefined)");
    const browserOpen = openMethod.indexOf("return this.seleniumBase.open(");
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(browserOpen).toBeGreaterThan(prepare);
    expect(openMethod).not.toContain("await this.visionRuntime.prepare()");
    expect(profileController).toContain('ipcMain.handle("get-seleniumbase-vision-status"');
    expect(profileController).toContain('ipcMain.handle("prepare-seleniumbase-vision"');
  });

  it("exposes diagnostics and one-command preparation through the SeleniumBase vision boundary", () => {
    expect(preload).toContain("getSeleniumBaseVisionStatus");
    expect(preload).toContain("prepareSeleniumBaseVision");
    expect(pkg.scripts["vision:status"]).toContain("vision_runtime_bootstrap.py --status");
    expect(pkg.scripts["vision:prepare"]).toContain("vision_runtime_bootstrap.py --prepare");
    expect(electronRuntime).toContain("SeleniumBaseVisionRuntime");
    expect(bootstrap).toContain('DEFAULT_MODEL = "google/siglip2-base-patch16-224"');
    expect(bootstrap).toContain("return _model_status(allow_download=True)");
  });
});
