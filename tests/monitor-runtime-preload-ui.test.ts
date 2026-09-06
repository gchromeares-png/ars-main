import * as fs from "fs";
import * as path from "path";

describe("monitor runtime preload UI", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.html"), "utf8");
  const preload = fs.readFileSync(
    path.resolve(__dirname, "../src/app/monitor-runtime-preload/monitor-runtime-preload.component.ts"),
    "utf8"
  );
  const electron = fs.readFileSync(path.resolve(__dirname, "../src/app/services/electron.service.ts"), "utf8");

  it("offers the compact preload control only on the normal product-monitor composer", () => {
    expect(html).toContain("<app-monitor-runtime-preload");
    expect(html).toContain("*ngIf=\"monitorStrategyMode === 'product-monitor'\"");
    expect(html).toContain("Runtime profile (optional)");
  });

  it("prepares SigLIP/Vision without opening a second browser session", () => {
    expect(preload).toContain("prepareSeleniumBaseVision()");
    expect(preload).not.toContain("openProfileBrowser(");
    expect(preload).toContain("SigLIP/Vision für Browser-Fallback vorladen");
    expect(preload).toContain("Vision ready");
  });

  it("uses the existing Electron vision preload API", () => {
    expect(electron).toContain("prepareSeleniumBaseVision(): Promise<any>");
    expect(electron).toContain("this.api.prepareSeleniumBaseVision()");
  });
});
