import * as fs from "fs";
import * as path from "path";

describe("Patchright task profile isolation", () => {
  const executor = fs.readFileSync(path.resolve(__dirname, "../src/shopify/patchright-shopify-executor.ts"), "utf8");
  const launcher = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/patchright-launcher.ts"), "utf8");
  const worker = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/patchright-browser-worker.ts"), "utf8");
  const main = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");

  it("keeps Patchright out of Electron and inside the external browser worker", () => {
    expect(main).toContain("BrowserWorkerPoolClient");
    expect(main).not.toContain("PatchrightShopifyTaskExecutor");
    expect(main).not.toContain('from "patchright"');
    expect(launcher).toContain('from "patchright"');
    expect(launcher).toContain("chromium.launchPersistentContext");
    expect(launcher).toContain('channel: "chrome"');
  });

  it("creates one persistent isolated Chrome profile per task", () => {
    expect(executor).toContain("userDataDir");
    expect(executor).toContain("this.safePartitionName(task.id)");
    expect(worker).toContain("new Map<string, BrowserContextHandle>()");
    expect(worker).toContain("pendingCreations");
  });

  it("uses the selected profile for proxy, user agent and checkout autofill", () => {
    expect(executor).toContain("profile.proxy");
    expect(executor).toContain("userAgent: profile.browser?.userAgent");
    expect(executor).toContain("fillCheckoutProfile(page, profile)");
  });

  it("does not submit final payment/order", () => {
    expect(executor).toContain("finalPaymentSubmitted: false");
  });
});
