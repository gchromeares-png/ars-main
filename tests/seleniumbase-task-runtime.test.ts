import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase task-runtime source guard", () => {
  const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const runtime = read("src/browser-worker/ares-browser-runtime.ts");
  const owner = read("src/browser-worker/seleniumbase-browser-worker.ts");
  const rpc = read("src/browser-worker/seleniumbase-rpc-page.ts");
  const py = read("python/seleniumbase_cdp/task_browser_worker.py");
  const adapter = read("python/seleniumbase_cdp/seleniumbase_adapter.py");
  const profileController = read("src/electron/profile-browser-controller.ts");

  it("removes Patchright as an installed runtime dependency", () => {
    expect(pkg.dependencies.patchright).toBeUndefined();
    expect(runtime).toContain('engine = "seleniumbase-cdp"');
    expect(owner).not.toContain('from "patchright-launcher"');
    expect(owner).not.toContain('require("patchright")');
  });

  it("blocks every task RPC until Python reports explicit READY", () => {
    expect(owner).toContain("await transport.start(");
    expect(rpc).toContain("rejected before explicit READY");
    expect(rpc).toContain("Cannot create SeleniumBase page before worker READY");
    expect(py).toContain('\"type\":\"ready\"');
  });

  it("keeps locator construction local and executes actions through one RPC", () => {
    expect(rpc).toContain("new SeleniumBaseRpcLocator(this, { selector })");
    expect(rpc).toContain('this.op("click"');
    expect(rpc).toContain('this.op("fill"');
    expect(rpc).toContain('this.op("count"');
  });

  it("restores root document after every frame-scoped action", () => {
    expect(py).toContain("self.sb.switch_to_frame(selector)");
    expect(py).toContain("finally:");
    expect(py).toContain("self.sb.switch_to_default_content()");
  });

  it("keeps fill atomic instead of mapping Playwright fill to slow typing", () => {
    expect(py).toContain("Object.getOwnPropertyDescriptor(proto, 'value')");
    expect(py).toContain("new Event('input'");
    expect(py).toContain("new Event('change'");
    expect(py).not.toContain("pyautogui");
  });

  it("preserves response telemetry through native CDP events", () => {
    expect(py).toContain("mycdp.network.ResponseReceived");
    expect(py).toContain("mycdp.network.get_response_body");
    expect(rpc).toContain("headers(): Record<string, string>");
    expect(rpc).toContain("async text(): Promise<string>");
  });

  it("uses CDP cookies before first navigation and keeps protected navigation order", () => {
    expect(owner).toContain("await context.addCookies(snapshot as unknown[])");
    expect(adapter).toContain("self._sb.set_all_cookies(params)");
    const goto = adapter.indexOf("self._sb.goto(url)");
    const stable = adapter.indexOf("self._challenge_tracker.wait_for_stable_challenge()");
    const solve = adapter.indexOf("self._sb.solve_captcha()");
    expect(goto).toBeGreaterThanOrEqual(0);
    expect(stable).toBeGreaterThan(goto);
    expect(solve).toBeGreaterThan(stable);
  });

  it("does not block manual browser startup on optional vision readiness", () => {
    expect(profileController).toContain("void this.visionRuntime.prepare().catch(() => undefined)");
    expect(profileController).toContain("return this.seleniumBase.open(profile, options.startUrl, options.cookieSnapshotId)");
    expect(profileController).not.toContain("if (!vision.ready)");
  });
});
