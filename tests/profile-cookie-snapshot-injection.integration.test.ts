import { mkdtemp, rm } from "fs/promises";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { SeleniumBaseBrowserWorker } from "../src/browser-worker/seleniumbase-browser-worker";
import { resolveProfileUserDataDir } from "../src/browser-worker/profile-session-manager";

const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1"
  ? describe
  : describe.skip;

describeBrowserIntegration("explicit profile cookie snapshot injection", () => {
  jest.setTimeout(60_000);

  it("sends the selected snapshot cookie on the first navigation of the profile run", async () => {
    let receivedCookie = "";
    const server = http.createServer((request, response) => {
      receivedCookie = String(request.headers.cookie ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body>ok</body></html>");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "ares-cookie-injection-"));
    const profileId = "cookie-profile";
    const taskId = "cookie-task";
    const worker = new SeleniumBaseBrowserWorker();

    try {
      worker.bindTaskProfile(taskId, profileId);
      worker.setTaskCookieSnapshot(taskId, [{
        name: "ares_selected_snapshot",
        value: "loaded",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax"
      }]);

      const handle = await worker.createContext({
        taskId,
        userDataDir: resolveProfileUserDataDir(profileId, root),
        headless: true,
        viewport: null
      });

      await handle.page.goto(origin, { waitUntil: "domcontentloaded" });
      expect(receivedCookie).toContain("ares_selected_snapshot=loaded");
    } finally {
      await worker.shutdown().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
