import * as fs from "fs";
import * as path from "path";

describe("profile-owned browser session persistence", () => {
  const browserWorker = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/seleniumbase-browser-worker.ts"),
    "utf8"
  );
  const manualController = fs.readFileSync(
    path.resolve(__dirname, "../src/electron/seleniumbase-profile-browser-controller.ts"),
    "utf8"
  );
  const workerRuntime = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/worker.ts"), "utf8");
  const protocol = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/protocol.ts"), "utf8");
  const electronMain = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");

  it("binds manual and task browser runs to profile-owned userDataDir paths", () => {
    expect(browserWorker).toContain("resolveProfileUserDataDir(profileId, requestedRoot)");
    expect(manualController).toContain("resolveProfileUserDataDir");
    expect(workerRuntime).toContain("browserCore.bindTaskProfile(request.task.id, request.profile.id)");
    expect(electronMain).toContain('browserProfileRoot = path.join(userData, "browser-profiles")');
    expect(electronMain).toContain("profileRoot: browserProfileRoot");
  });

  it("keeps task profile ownership explicit and isolated", () => {
    expect(browserWorker).toContain("activeProfileDirs");
    expect(browserWorker).toContain("profileLeases");
    expect(browserWorker).toContain("acquireBrowserProfileLease");
    expect(browserWorker).toContain("BrowserProfileInUseError");
  });

  it("lets SeleniumBase/Chromium own persistent profile flushing", () => {
    expect(browserWorker).toContain("await session.context.close()");
    expect(browserWorker).toContain("await this.waitForExit(runningChild, 5_000)");
  });

  it("injects only explicit task cookie snapshots before navigation", () => {
    for (const source of [browserWorker, manualController, workerRuntime, protocol, electronMain]) {
      expect(source).not.toMatch(/session[-_ ]?cookie[-_ ]?vault/i);
      expect(source).not.toMatch(/sessionCookies/i);
    }
    expect(browserWorker).toContain("taskCookieSnapshots");
    expect(browserWorker).toContain("await context.addCookies(snapshot as unknown[])");
    expect(manualController).toContain("readRegisteredProfileCookieSnapshot");
  });
});
