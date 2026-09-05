import { mkdtemp, rm } from "fs/promises";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { SeleniumBaseBrowserWorker } from "../src/browser-worker/seleniumbase-browser-worker";

const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1"
  ? describe
  : describe.skip;

function fixtureServer(): http.Server {
  return http.createServer((request, response) => {
    const address = request.socket.address() as AddressInfo;
    const port = address.port;
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");

    if (pathname === "/frame-a") {
      response.end(`<!doctype html><html><body>
        <button id="frame-button">frame-pending</button>
        <button id="swap-to-parent-site">swap-parent</button>
        <script>
          document.querySelector('#frame-button').addEventListener('click', event => {
            document.querySelector('#frame-button').textContent = 'frame:' + String(event.isTrusted);
          });
          document.querySelector('#swap-to-parent-site').addEventListener('click', () => {
            location.href = 'http://localhost:${port}/frame-b';
          });
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/frame-b") {
      response.end(`<!doctype html><html><body>
        <button id="after-swap">swap-pending</button>
        <button id="swap-back">swap-back</button>
        <script>
          document.querySelector('#after-swap').addEventListener('click', event => {
            document.querySelector('#after-swap').textContent = 'swap:' + String(event.isTrusted);
          });
          document.querySelector('#swap-back').addEventListener('click', () => {
            location.href = 'http://127.0.0.1:${port}/frame-c';
          });
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/frame-c") {
      response.end(`<!doctype html><html><body>
        <button id="after-back">back-pending</button>
        <script>
          document.querySelector('#after-back').addEventListener('click', event => {
            document.querySelector('#after-back').textContent = 'back:' + String(event.isTrusted);
          });
        </script>
      </body></html>`);
      return;
    }

    response.end(`<!doctype html><html><head><title>ARES OOPIF Input</title></head><body>
      <iframe id="oopif" src="http://127.0.0.1:${port}/frame-a" style="width:420px;height:180px"></iframe>
    </body></html>`);
  });
}

describeBrowserIntegration("OOPIF flattened CDP locator input", () => {
  jest.setTimeout(120_000);

  it("keeps trusted top-level mouse dispatch across cross-site RFH swaps", async () => {
    const server = fixtureServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const url = `http://localhost:${address.port}/`;
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ares-oopif-input-"));
    const browserWorker = new SeleniumBaseBrowserWorker();

    try {
      const handle = await browserWorker.createContext({
        taskId: "oopif-native-input-integration",
        userDataDir,
        headless: true,
        viewport: null,
        args: ["--site-per-process"],
        navigationTimeoutMs: 20_000,
        actionTimeoutMs: 10_000
      });

      await handle.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      const frame = handle.page.frameLocator("#oopif");

      await frame.locator("#frame-button").waitFor({ state: "visible", timeout: 10_000 });
      await frame.locator("#frame-button").click();
      expect(await frame.locator("#frame-button").innerText()).toBe("frame:true");

      await frame.locator("#swap-to-parent-site").click();
      await frame.locator("#after-swap").waitFor({ state: "visible", timeout: 10_000 });
      await frame.locator("#after-swap").click();
      expect(await frame.locator("#after-swap").innerText()).toBe("swap:true");

      await frame.locator("#swap-back").click();
      await frame.locator("#after-back").waitFor({ state: "visible", timeout: 10_000 });
      await frame.locator("#after-back").click();
      expect(await frame.locator("#after-back").innerText()).toBe("back:true");

      await browserWorker.closeContext("oopif-native-input-integration");
      expect((await browserWorker.health()).activeContexts).toBe(0);
    } finally {
      await browserWorker.shutdown().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
