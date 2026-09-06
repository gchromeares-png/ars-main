import * as fs from "fs";
import * as path from "path";

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

describe("grid debug fallback and task visibility", () => {
  const runtime = read("python/seleniumbase_cdp/visual_interaction_runtime.py");
  const controller = read("python/seleniumbase_cdp/auto_interaction_controller.py");
  const ui = read("src/app/app.component.html");

  it("captures a real grid screenshot and routes it into screenshot tile classification", () => {
    expect(runtime).toContain('self._debug_root = self._profile_dir / ".ares-observations"');
    expect(runtime).toContain("self._capture_grid_debug_screenshot(signature)");
    expect(runtime).toContain("self.poll_and_act_from_screenshot(");
    expect(runtime).toContain('source="screenshot-crops"');
    expect(runtime).toContain('"grid-screenshot-result"');
    expect(runtime).toContain("screenshotFirstForGrid");
    expect(runtime).toContain("debugScreenshotRoot");
  });

  it("allows the explicit screenshot fallback to act on an already detected image grid", () => {
    expect(controller).toContain("force_actionable=True");
    expect(controller).toContain("force_actionable: bool = False");
    expect(controller).toContain("actionable = self._actionable(state) or force_actionable");
    expect(controller).toContain('"reason": "no-click-resolved"');
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
