import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase CDP architecture guard", () => {
  const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");
  const requirements = read("requirements-seleniumbase-cdp.txt");
  const adapter = read("python/seleniumbase_cdp/seleniumbase_adapter.py");
  const tracker = read("python/seleniumbase_cdp/challenge_state_tracker.py");
  const trackerProbe = read("python/seleniumbase_cdp/challenge_state_tracker_probe.py");
  const siteAdapter = read("python/seleniumbase_cdp/site_grid_adapter.py");
  const siteAdapterProbe = read("python/seleniumbase_cdp/site_grid_adapter_probe.py");
  const gridActions = read("python/seleniumbase_cdp/authorized_grid_action_executor.py");
  const gridActionProbe = read("python/seleniumbase_cdp/authorized_grid_action_probe.py");
  const worker = read("python/seleniumbase_cdp/worker.py");
  const manualWorker = read("python/seleniumbase_cdp/manual_profile_browser.py");
  const manualController = read("src/electron/seleniumbase-profile-browser-controller.ts");
  const profileController = read("src/electron/profile-browser-controller.ts");
  const preload = read("src/electron/preload.ts");
  const probe = read("python/seleniumbase_cdp/persistence_probe.py");
  const manualProbe = read("python/seleniumbase_cdp/manual_profile_probe.py");
  const reopenProbe = read("python/seleniumbase_cdp/reopen_profile_probe.py");

  it("pins plain official SeleniumBase without a Playwright extra", () => {
    expect(requirements).toContain("seleniumbase==4.53.7");
    expect(requirements).not.toContain("seleniumbase[playwright]");
    expect(requirements.toLowerCase()).not.toContain("playwright");
    expect(adapter).toContain("from seleniumbase import sb_cdp");
    expect(adapter).toContain("sb_cdp.Chrome(");
    expect(adapter).toContain("user_data_dir");
    expect(adapter).toContain("self._sb.quit()");
    expect(adapter).not.toContain("selenium.webdriver");
  });

  it("keeps SeleniumBase and MyCDP behind one Python adapter boundary", () => {
    expect(adapter).toContain("import mycdp");
    expect(adapter).toContain("self._sb.set_all_cookies(params)");
    expect(adapter).toContain("self._sb.get_all_cookies()");
    expect(adapter).toContain("mycdp.network.CookieParam.from_json(payload)");
    for (const source of [adapter, worker, manualWorker, siteAdapter, gridActions]) {
      expect(source.toLowerCase()).not.toContain("playwright");
      expect(source).not.toContain("connect_over_cdp");
    }
    for (const source of [worker, manualWorker]) {
      expect(source).toContain("from seleniumbase_adapter import SeleniumBaseCdpAdapter");
      expect(source).not.toContain("from seleniumbase import");
      expect(source).not.toContain("import mycdp");
      expect(source).not.toContain("selenium.webdriver");
      expect(source).not.toContain("document.cookie");
    }
  });

  it("keeps the manual SeleniumBase path state-based instead of using a fixed captcha delay", () => {
    expect(adapter).toContain("self._sb.goto(url)");
    expect(adapter).toContain("self._challenge_tracker.wait_for_stable_challenge()");
    expect(adapter).toContain("self._sb.solve_captcha()");
    expect(adapter).not.toContain("self._sb.sleep(2)");
    expect(adapter).toContain("self._challenge_tracker.poll()");
    expect(manualWorker).toContain("adapter.goto(start_url)");
    expect(manualWorker).toContain("adapter.goto(");
    expect(manualController.toLowerCase()).not.toContain("patchright");
    expect(manualController).not.toContain("connectOverCDP");
  });

  it("tracks challenge iframe/grid state without URL hardcoding or solver behavior", () => {
    expect(tracker).toContain("class ChallengeStateTracker");
    expect(tracker).toContain('find_elements("iframe")');
    expect(tracker).toContain('frame.query_selector_all("img")');
    expect(tracker).toContain('"changedIndexes"');
    expect(tracker).toContain('_GRID_SIZES = {9: (3, 3), 16: (4, 4)}');
    expect(tracker).not.toContain("2captcha.com");
    expect(tracker).not.toContain("solve_captcha");
    expect(tracker).not.toContain("click(");
    expect(tracker).not.toContain("execute_script(");
    expect(tracker).not.toContain("set_all_cookies(");
    expect(trackerProbe).toContain('assert updated["changedIndexes"] == [4]');
  });

  it("adds a domain-agnostic read-only site grid adapter with overrides and state generations", () => {
    expect(siteAdapter).toContain("class GridSiteAdapter");
    expect(siteAdapter).toContain("_GRID_SIZES = {9: (3, 3), 16: (4, 4)}");
    expect(siteAdapter).toContain('find_elements("iframe")');
    expect(siteAdapter).toContain('frame.query_selector_all("img")');
    expect(siteAdapter).toContain("shadowRoot");
    expect(siteAdapter).toContain('allowed = {"root", "tiles", "instruction", "submit", "complete", "failed"}');
    expect(siteAdapter).toContain('"generation": self._generation');
    expect(siteAdapter).not.toContain("2captcha.com");
    expect(siteAdapter).not.toContain("solve_captcha");
    expect(siteAdapter).not.toContain(".click(");
    expect(siteAdapter).not.toContain("switch_to_frame");
    expect(siteAdapterProbe).toContain('assert framed["rows"] == 4 and framed["columns"] == 4');
  });

  it("keeps grid interaction separate from detection and revalidates state before clicking", () => {
    expect(adapter).toContain("AuthorizedGridActionExecutor");
    expect(adapter).toContain("def apply_grid_selection");
    expect(gridActions).toContain("expected_signature");
    expect(gridActions).toContain("shadowRoot");
    expect(gridActions).toContain("contentDocument");
    expect(gridActions).not.toContain("solve_captcha");
    expect(manualWorker).toContain('command_type == "grid-act"');
    expect(manualWorker).toContain('"type": "grid-action"');
    expect(gridActionProbe).toContain('expected_signature="wrong"');
  });

  it("enables the structural site adapter by default and exposes selector overrides", () => {
    expect(adapter).toContain("self._site_adapter = GridSiteAdapter");
    expect(adapter).toContain("def site_grid_state(self)");
    expect(adapter).toContain("self._site_adapter.poll()");
    expect(manualWorker).toContain('SITE_ADAPTER_FILENAME = ".ares-site-adapter.json"');
    expect(manualWorker).toContain('command.get("siteAdapterOverrides")');
    expect(manualWorker).toContain('command_type == "site-grid-state"');
    expect(manualWorker).toContain('"siteAdapterEnabled": True');
  });

  it("sends the SeleniumBase start payload after installing the ready listener", () => {
    const waitIndex = manualController.indexOf('const ready = this.waitForMessage(child, requestId, "ready", 30_000, true);');
    const writeIndex = manualController.indexOf('child.stdin.write(`${JSON.stringify(payload)}\\n`);');
    const awaitIndex = manualController.indexOf("const message = await ready;");
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(waitIndex);
    expect(awaitIndex).toBeGreaterThan(writeIndex);
  });

  it("restores the previous manual SeleniumBase URL and waits for persistent-profile shutdown", () => {
    expect(adapter).toContain("psutil.Process(chrome_pid).wait(timeout=5.0)");
    expect(adapter).toContain('time.sleep(1.0 if sys.platform.startswith("win") else 0.2)');
    expect(manualWorker).toContain('LAST_URL_FILENAME = ".ares-last-url"');
    expect(manualWorker).toContain('adapter.execute_script("return window.location.href;")');
    expect(manualWorker).toContain('start_url = str(command.get("startUrl") or "").strip() or last_url');
    expect(reopenProbe).toContain('RESTORE_PATH = "/restore-target"');
    expect(reopenProbe).toContain('WorkerClient(profile_dir, "")');
    expect(reopenProbe).toContain('active.wait("session-inspection", request_id, 15)');
    expect(reopenProbe).toContain("for index in range(2)");
  });

  it("inspects the existing SeleniumBase session without a second browser layer", () => {
    expect(adapter).toContain("def inspect_session(self)");
    expect(adapter).toContain("self._sb.get_current_url()");
    expect(adapter).toContain("self._sb.get_title()");
    expect(manualWorker).toContain('command_type == "inspect-session"');
    expect(manualWorker).toContain('"type": "session-inspection"');
    expect(manualWorker).not.toContain("attach-playwright");
    expect(manualWorker).not.toContain("inspect-playwright");
  });

  it("keeps the SeleniumBase worker isolated from Patchright and ARES protected cores", () => {
    for (const source of [adapter, tracker, siteAdapter, gridActions, worker, manualWorker, manualController]) {
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

  it("verifies cookies, native session inspection, and restart persistence", () => {
    expect(manualProbe).toContain('"/initial"');
    expect(manualProbe).toContain('"apply-cookies"');
    expect(manualProbe).toContain('"/same-session"');
    expect(manualProbe).toContain('"export-cookies"');
    expect(manualProbe).toContain('"inspect-session"');
    expect(manualProbe).toContain('"session-inspection"');
    expect(manualProbe).toContain('cookie.get("httpOnly") is not True');
    expect(manualProbe).toContain('"/restart"');
    expect(manualProbe.toLowerCase()).not.toContain("playwright");
  });
});
