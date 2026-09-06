import * as fs from "fs";
import * as path from "path";

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

describe("grid debug fallback and task visibility", () => {
  const runtime = read("python/seleniumbase_cdp/visual_interaction_runtime.py");
  const controller = read("python/seleniumbase_cdp/auto_interaction_controller.py");
  const ui = read("src/app/app.component.html");

  it("captures a real grid screenshot through the centralized observation capture and classifies screenshot tiles", () => {
    expect(runtime).toContain("ObservationCapture");
    expect(runtime).toContain("self._capture = capture or ObservationCapture(");
    expect(runtime).toContain('self._capture.capture(');
    expect(runtime).toContain("self.poll_and_act_from_screenshot(");
    expect(runtime).toContain('source="screenshot-crops"');
    expect(runtime).toContain('"grid-screenshot-result"');
    expect(runtime).toContain("screenshotFirstForGrid");
    expect(runtime).toContain("debugScreenshotRoot");
    expect(runtime).not.toContain('self._debug_root = self._profile_dir / ".ares-observations"');
  });

  it("allows the explicit screenshot path to force an already detected grid while preserving explicit failure semantics", () => {
    expect(controller).toContain("force_actionable=True");
    expect(controller).toContain("force_actionable: bool = False");
    expect(controller).toContain("actionable = self._actionable(state) or force_actionable");
    expect(controller).toContain('"reason": "vision-error-retry"');
    expect(controller).toContain('"incomplete-click-set"');
    expect(controller).toContain('"submit-not-confirmed"');
    expect(controller).toContain('"reason": "explicit-complete"');
  });

  it("keeps tasks visible and exposes direct per-task controls", () => {
    expect(ui).toContain("Product monitor");
    expect(ui).toContain('class="task-table surface"');
    expect(ui).toContain("tasks.slice().reverse()");
    expect(ui).toContain('(click)="startTask(task.id)"');
    expect(ui).toContain('(click)="pauseTask(task.id)"');
    expect(ui).toContain('(click)="resumeTask(task.id)"');
    expect(ui).toContain('(click)="stopTask(task.id)"');
    expect(ui).not.toContain('<details class="history-disclosure">');
  });
});
