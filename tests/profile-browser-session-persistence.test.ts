import * as fs from "fs";
import * as path from "path";

describe("profile-owned browser session persistence", () => {
  const browserWorker = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/patchright-browser-worker.ts"),
    "utf8"
  );
  const manualBrowser = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/manual-profile-browser.ts"),
    "utf8"
  );
  const workerRuntime = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/worker.ts"),
    "utf8"
  );
  const protocol = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/protocol.ts"),
    "utf8"
  );
  const electronMain = fs.readFileSync(
    path.resolve(__dirname, "../src/electron/main.ts"),
    "utf8"
  );

  it("binds manual and monitor browser runs to the same profile-owned userDataDir", () => {
    expect(manualBrowser).toContain("browser.bindTaskProfile(activeTaskId, profileId)");
    expect(workerRuntime).toContain("browserCore.bindTaskProfile(request.task.id, request.profile.id)");
    expect(browserWorker).toContain("resolveProfileUserDataDir(profileId, requestedRoot)");
    expect(electronMain).toContain('browserProfileRoot = path.join(userData, "browser-profiles")');
    expect(electronMain).toContain("profileRoot: browserProfileRoot");
  });

  it("keeps tab restore as a manual-browser convenience only", () => {
    expect(manualBrowser).toContain('args: ["--restore-last-session"]');
    expect(browserWorker).not.toContain("RESTORE_LAST_SESSION_ARG");
    expect(browserWorker).not.toContain('"--restore-last-session"');
  });

  it("lets Chromium flush the persistent profile without closing all pages first", () => {
    expect(browserWorker).toContain("await handle.context.close()");
    expect(browserWorker).not.toContain("pages.map(p => p.close()");
  });

  it("does not synthesize or persist session cookies outside Chromium", () => {
    for (const source of [browserWorker, manualBrowser, workerRuntime, protocol, electronMain]) {
      expect(source).not.toMatch(/session[-_ ]?cookie[-_ ]?vault/i);
      expect(source).not.toMatch(/sessionCookies/i);
    }
    expect(browserWorker).not.toContain("context.addCookies");
    expect(manualBrowser).not.toContain("context.addCookies");
    expect(workerRuntime).not.toContain("context.addCookies");
  });
});
