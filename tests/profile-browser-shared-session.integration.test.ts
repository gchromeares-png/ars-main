import { mkdtemp, rm } from "fs/promises";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { PatchrightBrowserWorker } from "../src/browser-worker/patchright-browser-worker";
import { resolveProfileUserDataDir } from "../src/browser-worker/profile-session-manager";

const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1"
  ? describe
  : describe.skip;

describeBrowserIntegration("shared profile browser persistence", () => {
  jest.setTimeout(60_000);

  it("keeps cookie and local storage when the same profile moves from manual browser to monitor run", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>ARES Profile Persistence</title></head><body>ok</body></html>");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "ares-shared-profile-"));
    const profileId = "shared-profile";
    const expectedDir = resolveProfileUserDataDir(profileId, root);

    const manualWorker = new PatchrightBrowserWorker();
    const monitorWorker = new PatchrightBrowserWorker();

    try {
      const manualTaskId = `manual-profile:${profileId}`;
      manualWorker.bindTaskProfile(manualTaskId, profileId);
      const manual = await manualWorker.createContext({
        taskId: manualTaskId,
        userDataDir: expectedDir,
        headless: true,
        viewport: null,
        args: ["--restore-last-session"]
      });

      expect(path.resolve(manual.userDataDir)).toBe(path.resolve(expectedDir));
      await manual.page.goto(origin, { waitUntil: "domcontentloaded" });
      await manual.page.evaluate(() => {
        document.cookie = "ares_profile_cookie=kept; path=/";
        localStorage.setItem("ares_profile_session", "kept");
      });
      await manualWorker.closeContext(manualTaskId);
      manualWorker.unbindTaskProfile(manualTaskId);

      const monitorTaskId = "monitor-profile-run";
      monitorWorker.bindTaskProfile(monitorTaskId, profileId);
      const monitor = await monitorWorker.createContext({
        taskId: monitorTaskId,
        userDataDir: path.join(root, "different-task-dir"),
        headless: true,
        viewport: null
      });

      expect(path.resolve(monitor.userDataDir)).toBe(path.resolve(expectedDir));
      await monitor.page.goto(origin, { waitUntil: "domcontentloaded" });
      const persisted = await monitor.page.evaluate(() => ({
        cookie: document.cookie,
        localStorage: localStorage.getItem("ares_profile_session")
      }));

      expect(persisted.cookie).toContain("ares_profile_cookie=kept");
      expect(persisted.localStorage).toBe("kept");
    } finally {
      await manualWorker.shutdown().catch(() => undefined);
      await monitorWorker.shutdown().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
