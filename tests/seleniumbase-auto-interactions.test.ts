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

  it("keeps grid and slider auto interactions enabled without blocking task RPC liveness", () => {
    expect(adapter).toContain("self._visual_interactions = VisualInteractionRuntime(");
    expect(adapter).toContain("self._poll_observation_watchdog(force=True)");
    expect(adapter).toContain("def _poll_observation_watchdog(");
    expect(adapter).toContain("self._visual_interactions.poll_and_act()");
    expect(adapter).not.toContain("self._poll_auto_interactions(");

    const livenessStart = adapter.indexOf("def is_running(self) -> bool:");
    const watchdogStart = adapter.indexOf("def _poll_observation_watchdog", livenessStart);
    expect(livenessStart).toBeGreaterThanOrEqual(0);
    expect(watchdogStart).toBeGreaterThan(livenessStart);
    const liveness = adapter.slice(livenessStart, watchdogStart);
    expect(liveness).not.toContain("_poll_observation_watchdog");
    expect(liveness).not.toContain("_challenge_tracker.poll");

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

  it("keeps automatic interaction modules on SeleniumBase-owned primitives", () => {
    expect(adapter).toContain("SeleniumBaseCdpAdapter");
    expect(runtime).toContain("AutoInteractionController");
    for (const source of [sliderAdapter, sliderActions, runtime, controller, vision]) {
      expect(source).not.toContain("src/challenges");
    }
  });
});
