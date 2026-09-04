import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const executor = fs.readFileSync(path.join(root, "src/shopify/patchright-shopify-executor.ts"), "utf8");
const launcher = fs.readFileSync(path.join(root, "src/browser-worker/patchright-launcher.ts"), "utf8");
const cursor = fs.readFileSync(path.join(root, "src/browser-worker/ui-interaction-helper.ts"), "utf8");
const interactionEngine = fs.readFileSync(path.join(root, "src/browser-worker/interaction-engine.ts"), "utf8");

describe("ARES browser core migration", () => {
  it("is Patchright-only and forces the Google Chrome channel at the launch boundary", () => {
    expect(pkg.dependencies.patchright).toBeTruthy();
    expect(pkg.dependencies.puppeteer).toBeUndefined();
    expect(pkg.dependencies["puppeteer-core"]).toBeUndefined();
    expect(launcher).toContain("chromium.launchPersistentContext(config.userDataDir");
    expect(launcher).toContain('channel: "chrome"');
    expect(pkg.scripts["browser:install"]).toBe("patchright install chrome");
  });

  it("routes persistent isolation and per-profile proxies through BrowserWorker", () => {
    expect(executor).toContain("this.browserWorker.createContext");
    expect(executor).toContain("this.safePartitionName(task.id)");
    expect(executor).toContain("profile.proxy");
    expect(launcher).toContain("proxy: toProxy(config.proxy)");
  });

  it("hardens proxied browser contexts against non-proxied WebRTC routes", () => {
    expect(launcher).toContain("--enforce-webrtc-ip-permission-check");
    expect(launcher).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(launcher).toContain("if (!config.proxy) return args.length ? args : undefined");
  });

  it("never removes Chromium singleton profile locks blindly", () => {
    expect(launcher).not.toContain("clearStaleChromeLocks");
    expect(launcher).not.toContain('rm(path.join(userDataDir');
    expect(launcher).toContain("Never unlink Chromium Singleton* files blindly");
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
