import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const executor = fs.readFileSync(path.join(root, "src/shopify/patchright-shopify-executor.ts"), "utf8");
const launcher = fs.readFileSync(path.join(root, "src/browser-worker/patchright-launcher.ts"), "utf8");
const cursor = fs.readFileSync(path.join(root, "src/browser-worker/ui-interaction-helper.ts"), "utf8");

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

  it("uses ghost-cursor path generation only as a Patchright UI interaction helper", () => {
    expect(pkg.dependencies["ghost-cursor"]).toBe("^1.4.2");
    expect(cursor).toContain('from "ghost-cursor"');
    expect(cursor).toContain("ghostPath(this.position, target)");
    expect(cursor).toContain("this.page.mouse.move");
    expect(cursor).toContain("this.page.mouse.click");
  });
});
