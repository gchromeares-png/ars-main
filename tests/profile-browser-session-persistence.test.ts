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

  it("restores the last Chrome session for both manual and monitor-owned profile contexts", () => {
    expect(manualBrowser).toContain('args: ["--restore-last-session"]');
    expect(browserWorker).toContain('const RESTORE_LAST_SESSION_ARG = "--restore-last-session"');
    expect(browserWorker).toContain("if (profileId && !args.includes(RESTORE_LAST_SESSION_ARG)) args.push(RESTORE_LAST_SESSION_ARG)");
  });

  it("lets Chromium flush the persistent profile without closing all pages first", () => {
    expect(browserWorker).toContain("await handle.context.close()");
    expect(browserWorker).not.toContain("pages.map(p => p.close()");
  });
});
