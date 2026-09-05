import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase profile-owned browser isolation", () => {
  const executor = fs.readFileSync(path.resolve(__dirname, "../src/shopify/shopify-task-executor.ts"), "utf8");
  const worker = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/seleniumbase-browser-worker.ts"), "utf8");
  const sessionManager = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/profile-session-manager.ts"), "utf8");
  const runtimeWorker = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/worker.ts"), "utf8");
  const main = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");

  it("keeps browser automation in the external SeleniumBase worker", () => {
    expect(main).toContain("BrowserWorkerPoolClient");
    expect(executor).toContain("SeleniumBaseBrowserWorker");
    expect(worker).toContain("task_browser_worker.py");
    expect(worker).toContain("await transport.start(");
  });

  it("routes tasks through one persistent browser directory per ARES profile", () => {
    expect(executor).toContain("userDataDir");
    expect(worker).toContain("bindTaskProfile");
    expect(worker).toContain("resolveProfileUserDataDir");
    expect(sessionManager).toContain("profile_${normalized}");
    expect(runtimeWorker).toContain("isolatedPerProfile: true");
  });

  it("prevents simultaneous reuse with an atomic cross-process profile lease", () => {
    expect(sessionManager).toContain('fs.openSync(lockPath, "wx")');
    expect(sessionManager).toContain("isProcessAlive");
    expect(worker).toContain("acquireBrowserProfileLease");
    expect(worker).toContain("BrowserProfileInUseError");
  });

  it("uses the selected profile for proxy, user agent and checkout autofill", () => {
    expect(executor).toContain("profile.proxy");
    expect(executor).toContain("userAgent: profile.browser?.userAgent");
    expect(executor).toContain("fillCheckoutProfile(page, profile)");
  });

  it("does not submit final payment/order in the regular Shopify executor", () => {
    expect(executor).toContain("finalPaymentSubmitted: false");
  });
});
