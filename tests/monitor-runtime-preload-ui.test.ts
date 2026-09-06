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
    expect(html).toContain("[shopId]=\"selectedShopId\"");
    expect(html).toContain("[profileId]=\"selectedProfileId\"");
    expect(html).toContain("Runtime profile (optional)");
  });

  it("prepares vision before opening the persistent SeleniumBase profile runtime", () => {
    const prepareIndex = preload.indexOf("prepareSeleniumBaseVision()");
    const openIndex = preload.indexOf("openProfileBrowser(profileId, startUrl)");
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(prepareIndex);
    expect(preload).toContain("SeleniumBase + Vision Runtime für den Monitor vorladen");
    expect(preload).toContain("Runtime ready");
  });

  it("uses the existing Electron preload API instead of a second browser implementation", () => {
    expect(electron).toContain("prepareSeleniumBaseVision(): Promise<any>");
    expect(electron).toContain("this.api.prepareSeleniumBaseVision()");
    expect(electron).toContain("openProfileBrowser(profileId: string, startUrl?: string)");
    expect(electron).toContain("this.api.openProfileBrowser(profileId, startUrl)");
  });
});
