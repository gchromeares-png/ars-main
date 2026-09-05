import * as fs from "fs";
import * as path from "path";

describe("profile browser runtime default", () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, "../src/electron/profile-browser-controller.ts"),
    "utf8"
  );

  it("routes normal profile-browser opens through SeleniumBase without an opt-in flag", () => {
    expect(controller).toContain("new SeleniumBaseProfileBrowserController");
    expect(controller).toContain("return this.seleniumBase.open(profile, options.startUrl, options.cookieSnapshotId)");
    expect(controller).not.toContain("manual-profile-browser.js");
    expect(controller).not.toContain("spawn(");
  });

  it("uses the same SeleniumBase owner for status, cookies and lifecycle", () => {
    expect(controller).toContain("return this.seleniumBase.captureCookies(profileId)");
    expect(controller).toContain("return this.seleniumBase.close(profileId)");
    expect(controller).toContain("return this.seleniumBase.status(profileId)");
    expect(controller).toContain("return this.seleniumBase.isOpen(profileId)");
    expect(controller).toContain("return this.seleniumBase.closeAll()");
  });
});
