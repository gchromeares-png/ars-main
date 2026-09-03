import * as fs from "fs";
import * as path from "path";

describe("global InteractionEngine architecture", () => {
  const helperPath = path.resolve(__dirname, "../src/browser-worker/ui-interaction-helper.ts");
  const legacyPath = path.resolve(__dirname, "../src/browser/bezier-cursor-service.ts");
  const helper = fs.readFileSync(helperPath, "utf8");
  const legacy = fs.readFileSync(legacyPath, "utf8");

  it("routes stateful normal UI actions through InteractionEngine", () => {
    expect(helper).toContain('import { InteractionEngine } from "./interaction-engine"');
    expect(helper).toContain("this.engine.click(");
    expect(helper).toContain("this.engine.fill(");
    expect(helper).toContain("this.engine.select(");
    expect(helper).toContain("this.engine.focus(");
  });

  it("does not keep ghost-cursor planning in the compatibility helper", () => {
    expect(helper).not.toContain('from "ghost-cursor"');
    expect(helper).not.toContain("ghostPath(");
  });

  it("keeps the legacy cursor service delegation-only", () => {
    expect(legacy).toContain("GhostCursorUiInteractionHelper");
    expect(legacy).not.toContain('from "ghost-cursor"');
    expect(legacy).not.toContain("page.mouse.click");
    expect(legacy).not.toContain("locator.fill");
    expect(legacy).not.toContain("selectOption");
  });
});
