import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const executor = fs.readFileSync(path.join(root, "src/shopify/shopify-task-executor.ts"), "utf8");
const runtime = fs.readFileSync(path.join(root, "src/browser-worker/ares-browser-runtime.ts"), "utf8");
const browserWorker = fs.readFileSync(path.join(root, "src/browser-worker/seleniumbase-browser-worker.ts"), "utf8");
const rpcPage = fs.readFileSync(path.join(root, "src/browser-worker/seleniumbase-rpc-page.ts"), "utf8");
const cursor = fs.readFileSync(path.join(root, "src/browser-worker/ui-interaction-helper.ts"), "utf8");
const interactionEngine = fs.readFileSync(path.join(root, "src/browser-worker/interaction-engine.ts"), "utf8");

describe("ARES browser core migration", () => {
  it("uses SeleniumBase Pure CDP as the only installed task browser engine", () => {
    expect(pkg.dependencies.patchright).toBeUndefined();
    expect(pkg.dependencies.puppeteer).toBeUndefined();
    expect(pkg.dependencies["puppeteer-core"]).toBeUndefined();
    expect(pkg.scripts["browser:install"]).toContain("requirements-seleniumbase-cdp.txt");
    expect(runtime).toContain('engine = "seleniumbase-cdp"');
    expect(runtime).toContain("extends SeleniumBaseBrowserWorker");
    expect(executor).toContain("new SeleniumBaseBrowserWorker()");
    expect(executor).toContain('type: "seleniumbase-cdp"');
  });

  it("routes persistent isolation and per-profile proxies through BrowserWorker", () => {
    expect(executor).toContain("this.browserWorker.createContext");
    expect(executor).toContain("this.safePartitionName(task.id)");
    expect(executor).toContain("profile.proxy");
    expect(browserWorker).toContain("resolveProfileUserDataDir");
    expect(browserWorker).toContain("proxyValue(config.proxy)");
  });

  it("hardens proxied SeleniumBase Chrome against non-proxied WebRTC routes", () => {
    expect(browserWorker).toContain("--enforce-webrtc-ip-permission-check");
    expect(browserWorker).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  });

  it("hardens proxied SeleniumBase Chrome against direct DNS paths", () => {
    expect(browserWorker).toContain("--disable-async-dns");
    expect(browserWorker).toContain("DnsOverHttps");
    expect(browserWorker).toContain("NetworkPrediction");
    expect(browserWorker).toContain("--host-resolver-rules=");
    expect(browserWorker).toContain("MAP * ~NOTFOUND , EXCLUDE");
  });

  it("requires explicit Python READY before exposing Page or Locator RPC", () => {
    expect(browserWorker).toContain("await transport.start(");
    const readyIndex = browserWorker.indexOf("await transport.start(");
    const pageIndex = browserWorker.indexOf("new SeleniumBaseRpcPage(transport)");
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(pageIndex).toBeGreaterThan(readyIndex);
    expect(rpcPage).toContain("rejected before explicit READY");
    expect(rpcPage).toContain("Cannot create SeleniumBase page before worker READY");
  });

  it("keeps locator construction lazy and uses one RPC per real operation", () => {
    expect(rpcPage).toContain("locatorOperation(");
    expect(rpcPage).toContain('this.op("click"');
    expect(rpcPage).toContain('this.op("fill"');
    expect(rpcPage).toContain('this.op("count"');
  });

  it("routes normal UI actions through the global stateful InteractionEngine", () => {
    expect(cursor).toContain('import { InteractionEngine } from "./interaction-engine"');
    expect(cursor).not.toContain('from "ghost-cursor"');
    expect(cursor).toContain("this.engine.click");
    expect(cursor).toContain("this.engine.fill");
    expect(cursor).toContain("this.engine.select");
    expect(cursor).toContain("this.engine.focus");
    expect(interactionEngine).toContain("waitUntilReady");
    expect(interactionEngine).toContain("waitForOutcome");
  });
});
