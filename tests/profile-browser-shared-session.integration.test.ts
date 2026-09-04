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

  it("proves whether persistent cookies, session cookies, local storage and login survive a profile reopen", async () => {
    const server = http.createServer((request, response) => {
      const cookies = String(request.headers.cookie || "");

      if (request.url === "/login") {
        response.setHeader("Set-Cookie", [
          "ares_session=kept; Path=/; HttpOnly; SameSite=Lax",
          "ares_persistent=kept; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax"
        ]);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><head><title>ARES Login</title></head><body>logged-in</body></html>");
        return;
      }

      if (request.url === "/whoami") {
        const loggedIn = cookies.includes("ares_session=kept");
        response.writeHead(loggedIn ? 200 : 401, { "content-type": "text/plain; charset=utf-8" });
        response.end(loggedIn ? "logged-in" : "logged-out");
        return;
      }

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
        viewport: null
      });

      expect(path.resolve(manual.userDataDir)).toBe(path.resolve(expectedDir));
      await manual.page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
      await manual.page.evaluate(() => {
        localStorage.setItem("ares_profile_session", "kept");
      });

      const beforeClose = await manual.context.cookies(origin);
      const sessionBefore = beforeClose.find(cookie => cookie.name === "ares_session");
      const persistentBefore = beforeClose.find(cookie => cookie.name === "ares_persistent");

      expect(sessionBefore).toBeDefined();
      expect(sessionBefore?.expires).toBeLessThanOrEqual(0);
      expect(persistentBefore).toBeDefined();
      expect(Number(persistentBefore?.expires)).toBeGreaterThan(0);

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

      const afterReopen = await monitor.context.cookies(origin);
      const sessionAfter = afterReopen.find(cookie => cookie.name === "ares_session");
      const persistentAfter = afterReopen.find(cookie => cookie.name === "ares_persistent");

      expect(persistentAfter?.value).toBe("kept");
      expect(sessionAfter?.value).toBe("kept");

      await monitor.page.goto(origin, { waitUntil: "domcontentloaded" });
      expect(await monitor.page.evaluate(() => localStorage.getItem("ares_profile_session"))).toBe("kept");

      const whoAmI = await monitor.page.goto(`${origin}/whoami`, { waitUntil: "domcontentloaded" });
      expect(whoAmI?.status()).toBe(200);
      expect((await monitor.page.textContent("body"))?.trim()).toBe("logged-in");
    } finally {
      await manualWorker.shutdown().catch(() => undefined);
      await monitorWorker.shutdown().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
