import * as fs from "fs";
import * as path from "path";

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

describe("SeleniumBase automatic interaction runtime", () => {
  const adapter = read("python/seleniumbase_cdp/seleniumbase_adapter.py");
  const sliderAdapter = read("python/seleniumbase_cdp/site_slider_adapter.py");
  const sliderActions = read("python/seleniumbase_cdp/slider_action_executor.py");
  const runtime = read("python/seleniumbase_cdp/visual_interaction_runtime.py");
  const controller = read("python/seleniumbase_cdp/auto_interaction_controller.py");
  const vision = read("python/seleniumbase_cdp/vision_grid_classifier.py");
  const worker = read("python/seleniumbase_cdp/manual_profile_browser.py");

  it("keeps grid and slider auto interactions enabled by default", () => {
    expect(adapter).toContain("self._visual_interactions = VisualInteractionRuntime(");
    expect(adapter).toContain("self._poll_auto_interactions(force=True)");
    expect(adapter).toContain("self._poll_auto_interactions()");
    expect(adapter).toContain("self._visual_interactions.poll_and_act()");
    expect(runtime).toContain("AutoInteractionController(");
    expect(worker).toContain('\"autoInteractionsEnabled\": True');
    expect(worker).toContain('\"sliderActionsEnabled\": True');
    expect(worker).not.toContain("authorizedTestMode");
  });

  it("detects sliders structurally with shadow and iframe traversal plus overrides", () => {
    expect(sliderAdapter).toContain("class SliderSiteAdapter");
    expect(sliderAdapter).toContain("shadowRoot");
    expect(sliderAdapter).toContain("frame.contentDocument");
    expect(sliderAdapter).toContain("sliderHandle");
    expect(sliderAdapter).toContain("sliderTrack");
    expect(sliderAdapter).not.toContain("2captcha.com");
  });

  it("uses relative slider movement rather than fixed pixels", () => {
    expect(sliderActions).toContain("target_fraction");
    expect(sliderActions).toContain("r.width * target");
    expect(sliderActions).toContain("r.height * target");
    expect(sliderActions).not.toContain("2captcha.com");
  });

  it("keeps zero-shot vision lazy and model-configurable", () => {
    expect(vision).toContain('google/siglip2-base-patch16-224');
    expect(vision).toContain("from transformers import AutoModel, AutoProcessor");
    expect(vision).toContain("ARES_VISION_MODEL");
    expect(vision).toContain("ARES_VISION_THRESHOLD");
    expect(vision).toContain("ARES_VISION_OFFLINE");
  });

  it("does not couple the automatic interaction modules to Playwright or Patchright", () => {
    for (const source of [sliderAdapter, sliderActions, runtime, controller, vision]) {
      expect(source.toLowerCase()).not.toContain("playwright");
      expect(source.toLowerCase()).not.toContain("patchright");
      expect(source).not.toContain("src/challenges");
    }
  });
});
