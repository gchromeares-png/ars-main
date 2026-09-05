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
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");

    if (pathname === "/frame") {
      response.end(`<!doctype html><html><body>
        <button id="frame-button">frame-pending</button>
        <script>
          document.querySelector('#frame-button').addEventListener('click', event => {
            document.querySelector('#frame-button').textContent = 'frame:' + String(event.isTrusted);
          });
        </script>
      </body></html>`);
      return;
    }

    response.end(`<!doctype html><html><head><title>ARES Native Input</title>
      <style>
        #blocked-wrap { position: relative; width: 180px; height: 48px; }
        #blocked-button { position: absolute; inset: 0; }
        #blocking-overlay { position: absolute; inset: 0; z-index: 5; background: rgba(0,0,0,.01); }
      </style>
      </head><body>
        <button id="native-button">native-pending</button>
        <div id="blocked-wrap">
          <button id="blocked-button">blocked-pending</button>
          <div id="blocking-overlay"></div>
        </div>
        <input id="fast-input" />
        <div id="fill-result">fill-pending</div>
        <iframe id="native-frame" src="/frame" style="width:320px;height:120px"></iframe>
        <script>
          document.querySelector('#native-button').addEventListener('click', event => {
            document.querySelector('#native-button').textContent = 'click:' + String(event.isTrusted);
          });
          document.querySelector('#blocked-button').addEventListener('click', event => {
            document.querySelector('#blocked-button').textContent = 'blocked:' + String(event.isTrusted);
          });
          document.querySelector('#fast-input').addEventListener('input', event => {
            document.querySelector('#fill-result').textContent = 'fill:' + String(event.isTrusted);
          });
        </script>
      </body></html>`);
  });
}

describeBrowserIntegration("CDP-native locator input", () => {
  jest.setTimeout(90_000);

  it("uses trusted mouse input for locator clicks, stays frame-safe, and fails closed when hit-test is blocked", async () => {
    const server = fixtureServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/`;
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ares-native-input-"));
    const browserWorker = new SeleniumBaseBrowserWorker();

    try {
      const handle = await browserWorker.createContext({
        taskId: "native-input-integration",
        userDataDir,
        headless: true,
        viewport: null,
        navigationTimeoutMs: 20_000,
        actionTimeoutMs: 8_000
      });

      await handle.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });

      await handle.page.locator("#native-button").click();
      expect(await handle.page.locator("#native-button").innerText()).toBe("click:true");

      const frame = handle.page.frameLocator("#native-frame");
      await frame.locator("#frame-button").click();
      expect(await frame.locator("#frame-button").innerText()).toBe("frame:true");

      await expect(handle.page.locator("#blocked-button").click()).rejects.toThrow(/hit-test failed/i);
      expect(await handle.page.locator("#blocked-button").innerText()).toBe("blocked-pending");

      await handle.page.locator("#fast-input").fill("throughput-ok");
      expect(await handle.page.locator("#fast-input").inputValue()).toBe("throughput-ok");
      expect(await handle.page.locator("#fill-result").innerText()).toMatch(/^fill:(?:true|false)$/);

      await browserWorker.closeContext("native-input-integration");
      expect((await browserWorker.health()).activeContexts).toBe(0);
    } finally {
      await browserWorker.shutdown().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
