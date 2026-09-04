import * as fs from "fs";
import * as path from "path";

describe("Patchright profile-owned browser isolation", () => {
  const executor = fs.readFileSync(path.resolve(__dirname, "../src/shopify/patchright-shopify-executor.ts"), "utf8");
  const launcher = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/patchright-launcher.ts"), "utf8");
  const worker = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/patchright-browser-worker.ts"), "utf8");
  const sessionManager = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/profile-session-manager.ts"), "utf8");
  const runtimeWorker = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/worker.ts"), "utf8");
  const main = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");

  it("keeps Patchright out of Electron and inside the external browser worker", () => {
    expect(main).toContain("BrowserWorkerPoolClient");
    expect(main).not.toContain("PatchrightShopifyTaskExecutor");
    expect(main).not.toContain('from "patchright"');
    expect(launcher).toContain('from "patchright"');
    expect(launcher).toContain("chromium.launchPersistentContext");
    expect(launcher).toContain('channel: "chrome"');
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