import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase CDP PoC architecture guard", () => {
  const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");
  const requirements = read("requirements-seleniumbase-cdp.txt");
  const adapter = read("python/seleniumbase_cdp/seleniumbase_adapter.py");
  const worker = read("python/seleniumbase_cdp/worker.py");
  const manualWorker = read("python/seleniumbase_cdp/manual_profile_browser.py");
  const manualController = read("src/electron/seleniumbase-profile-browser-controller.ts");
  const profileController = read("src/electron/profile-browser-controller.ts");
  const preload = read("src/electron/preload.ts");
  const probe = read("python/seleniumbase_cdp/persistence_probe.py");
  const manualProbe = read("python/seleniumbase_cdp/manual_profile_probe.py");

  it("pins official SeleniumBase with its Playwright integration extra", () => {
    expect(requirements).toContain("seleniumbase[playwright]==4.53.7");
    expect(adapter).toContain("from seleniumbase import sb_cdp");
    expect(adapter).toContain("sb_cdp.Chrome(");
    expect(adapter).toContain("user_data_dir");
    expect(adapter).toContain("self._sb.quit()");
    expect(adapter).not.toContain("selenium.webdriver");
  });

  it("keeps SeleniumBase, MyCDP, and Playwright behind one Python adapter boundary", () => {
    expect(adapter).toContain("import mycdp");
    expect(adapter).toContain("from playwright.sync_api import sync_playwright");
    expect(adapter).toContain("self._sb.set_all_cookies(params)");
    expect(adapter).toContain("self._sb.get_all_cookies()");
    expect(adapter).toContain("mycdp.network.CookieParam.from_json(payload)");
    for (const source of [worker, manualWorker]) {
      expect(source).toContain("from seleniumbase_adapter import SeleniumBaseCdpAdapter");
      expect(source).not.toContain("from seleniumbase import");
      expect(source).not.toContain("import mycdp");
      expect(source).not.toContain("playwright.sync_api");
      expect(source).not.toContain("selenium.webdriver");
      expect(source).not.toContain("document.cookie");
    }
  });

  it("implements SeleniumBase Stealthy Playwright Mode on the existing context/page only", () => {
    expect(adapter).toContain("self._sb.get_endpoint_url()");
    expect(adapter).toContain("playwright.chromium.connect_over_cdp(endpoint_url)");
    expect(adapter).toContain("context = browser.contexts[0]");
    expect(adapter).toContain("page = context.pages[0]");
    expect(adapter).not.toContain("new_context(");
    expect(manualWorker).toContain('command_type == "attach-playwright"');
    expect(manualWorker).toContain('command_type == "inspect-playwright"');
  });

  it("keeps the SeleniumBase worker isolated from Patchright and ARES protected cores", () => {
    for (const source of [adapter, worker, manualWorker, manualController]) {
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

  it("verifies cookies, same-session assignment, Stealthy Playwright attach, and restart persistence", () => {
    expect(manualProbe).toContain('"/initial"');
    expect(manualProbe).toContain('"apply-cookies"');
    expect(manualProbe).toContain('"/same-session"');
    expect(manualProbe).toContain('"export-cookies"');
    expect(manualProbe).toContain('"attach-playwright"');
    expect(manualProbe).toContain('"playwright-attached"');
    expect(manualProbe).toContain('cookie.get("httpOnly") is not True');
    expect(manualProbe).toContain('"/restart"');
  });
});
