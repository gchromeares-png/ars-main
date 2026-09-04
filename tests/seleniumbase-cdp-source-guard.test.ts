import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase CDP PoC architecture guard", () => {
  const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");
  const requirements = read("requirements-seleniumbase-cdp.txt");
  const worker = read("python/seleniumbase_cdp/worker.py");
  const manualWorker = read("python/seleniumbase_cdp/manual_profile_browser.py");
  const manualController = read("src/electron/seleniumbase-profile-browser-controller.ts");
  const profileController = read("src/electron/profile-browser-controller.ts");
  const preload = read("src/electron/preload.ts");
  const probe = read("python/seleniumbase_cdp/persistence_probe.py");
  const manualProbe = read("python/seleniumbase_cdp/manual_profile_probe.py");

  it("uses pinned SeleniumBase pure CDP without classic Selenium WebDriver", () => {
    expect(requirements).toContain("seleniumbase==4.53.7");
    for (const source of [worker, manualWorker]) {
      expect(source).toContain("from seleniumbase import sb_cdp");
      expect(source).toContain("sb_cdp.Chrome(");
      expect(source).toContain("user_data_dir");
      expect(source).toContain("sb.quit()");
      expect(source).not.toContain("selenium.webdriver");
    }
  });

  it("uses SeleniumBase CDP cookie APIs instead of document.cookie injection", () => {
    expect(manualWorker).toContain("sb.set_all_cookies(params)");
    expect(manualWorker).toContain("sb.get_all_cookies()");
    expect(manualWorker).toContain("mycdp.network.CookieParam.from_json(payload)");
    expect(manualWorker).not.toContain("document.cookie");
  });

  it("keeps the SeleniumBase worker isolated from Patchright and ARES protected cores", () => {
    for (const source of [worker, manualWorker, manualController]) {
      expect(source.toLowerCase()).not.toContain("patchright");
      expect(source).not.toContain("src/challenges");
      expect(source).not.toContain("field-semantic-resolver");
      expect(source).not.toContain("payment-preparer");
    }
    expect(manualController).toContain('const SELENIUMBASE_PROFILE_DIR = ".ares-seleniumbase-cdp"');
    expect(manualController).toContain("resolveUserDataDir(profileId)");
  });

  it("exposes SeleniumBase only as an explicit manual experimental browser path", () => {
    expect(profileController).toContain('engine: "seleniumbase-cdp"');
    expect(profileController).toContain("this.seleniumBase.open(");
    expect(preload).toContain("openSeleniumBaseProfileBrowser");
    expect(preload).toContain("applySeleniumBaseCookieSnapshot");
    expect(preload).toContain("saveSeleniumBaseProfileCookieSnapshot");
  });

  it("verifies persistence through two separate worker processes using one SeleniumBase profile", () => {
    expect(probe).toContain("subprocess.run(");
    expect(probe).toContain('action="seed-persistence"');
    expect(probe).toContain('action="read-persistence"');
    expect(probe).toContain("profile_dir=profile_dir");
    expect(probe).toContain("second Python process");
  });

  it("verifies initial cookie assignment, same-session assignment, export and restart persistence", () => {
    expect(manualProbe).toContain('"/initial"');
    expect(manualProbe).toContain('"apply-cookies"');
    expect(manualProbe).toContain('"/same-session"');
    expect(manualProbe).toContain('"export-cookies"');
    expect(manualProbe).toContain('cookie_a.get("httpOnly") is not True');
    expect(manualProbe).toContain('"/restart"');
  });
});
