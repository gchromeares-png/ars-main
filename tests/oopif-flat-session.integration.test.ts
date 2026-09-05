import { spawnSync } from "child_process";
import * as fs from "fs";
import { mkdtemp, rm } from "fs/promises";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { SeleniumBaseBrowserWorker } from "../src/browser-worker/seleniumbase-browser-worker";

const runtimePath = path.resolve(__dirname, "../python/seleniumbase_cdp/oopif_session_runtime.py");
const entryPath = path.resolve(__dirname, "../python/seleniumbase_cdp/task_browser_worker_entry.py");
const workerPath = path.resolve(__dirname, "../src/browser-worker/seleniumbase-browser-worker.ts");

const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1"
  ? describe
  : describe.skip;

function listen(server: http.Server, host = "127.0.0.1"): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address() as AddressInfo));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>(resolve => server.close(() => resolve()));
}

describe("OOPIF flat-session contract", () => {
  it("keeps flat child sessions isolated and redirect cleanup session-safe", () => {
    const runtime = fs.readFileSync(runtimePath, "utf8");
    const entry = fs.readFileSync(entryPath, "utf8");
    const worker = fs.readFileSync(workerPath, "utf8");

    expect(runtime).toContain("FLAT_SESSION_REQUEST_ID_START = 10_000_000");
    expect(runtime).toContain('"Target.setAutoAttach"');
    expect(runtime).toContain('"flatten": True');
    expect(runtime).toContain('"DOM.enable"');
    expect(runtime).toContain('"Runtime.enable"');
    expect(runtime).toContain("self._sessions[(root_id, session_id)]");
    expect(runtime).toContain("self._frame_sessions[(root_id, frame_id)] = session_id");
    expect(runtime).toContain("if self._frame_sessions.get(key) == session_id:");
    expect(runtime).not.toContain('"executionContextId"');

    expect(entry).toContain("class OopifTaskRpcRuntime(base_worker.TaskRpcRuntime)");
    expect(entry).toContain("base_worker.TaskRpcRuntime = OopifTaskRpcRuntime");
    expect(entry).toContain("self._oopif_runtime.evaluate_path");
    expect(entry).toContain("self._oopif_runtime.frame_viewport_offset");

    expect(worker.indexOf("task_browser_worker_entry.py"))
      .toBeLessThan(worker.indexOf('"task_browser_worker.py"'));
  });

  it("python-compiles the isolated runtime and entrypoint", () => {
    const python = process.env["ARES_PYTHON_EXECUTABLE"]?.trim() || "python";
    const result = spawnSync(python, ["-m", "py_compile", runtimePath, entryPath], {
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout || ""}${result.stderr || ""}`).toBe("");
  });
});

describeBrowserIntegration("OOPIF cross-origin browser integration", () => {
  jest.setTimeout(120_000);

  it("clicks trusted controls across an OOPIF RFH swap and a nested frame", async () => {
    let childPort = 0;

    const childServer = http.createServer((request, response) => {
      const host = String(request.headers.host || "");
      const pathname = new URL(request.url || "/", `http://${host || "a.test"}`).pathname;
      response.setHeader("content-type", "text/html; charset=utf-8");

      if (pathname === "/a") {
        response.end(`<!doctype html><html><body>
          <button id="phase-a">a-pending</button>
          <button id="swap">swap</button>
          <script>
            document.querySelector('#phase-a').addEventListener('click', event => {
              document.querySelector('#phase-a').textContent = 'a:' + String(event.isTrusted);
            });
            document.querySelector('#swap').addEventListener('click', () => {
              location.href = 'http://b.test:${childPort}/b';
            });
          </script>
        </body></html>`);
        return;
      }

      if (pathname === "/nested") {
        response.end(`<!doctype html><html><body>
          <button id="nested-button">nested-pending</button>
          <script>
            document.querySelector('#nested-button').addEventListener('click', event => {
              document.querySelector('#nested-button').textContent = 'nested:' + String(event.isTrusted);
            });
          </script>
        </body></html>`);
        return;
      }

      response.end(`<!doctype html><html><body>
        <button id="phase-b">b-pending</button>
        <iframe id="nested-frame" src="/nested" style="width:320px;height:100px"></iframe>
        <script>
          document.querySelector('#phase-b').addEventListener('click', event => {
            document.querySelector('#phase-b').textContent = 'b:' + String(event.isTrusted);
          });
        </script>
      </body></html>`);
    });

    const childAddress = await listen(childServer);
    childPort = childAddress.port;

    const parentServer = http.createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><title>ARES OOPIF</title></head><body>
        <iframe id="oopif-frame" src="http://a.test:${childPort}/a" style="width:500px;height:300px"></iframe>
      </body></html>`);
    });
    const parentAddress = await listen(parentServer);

    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ares-oopif-"));
    const browserWorker = new SeleniumBaseBrowserWorker();

    try {
      const handle = await browserWorker.createContext({
        taskId: "oopif-flat-session-integration",
        userDataDir,
        headless: true,
        viewport: null,
        args: [
          "--site-per-process",
          "--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1"
        ],
        navigationTimeoutMs: 20_000,
        actionTimeoutMs: 10_000
      });

      await handle.page.goto(`http://127.0.0.1:${parentAddress.port}/`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000
      });

      const frame = handle.page.frameLocator("#oopif-frame");
      await frame.locator("#phase-a").waitFor({ state: "visible", timeout: 15_000 });
      await frame.locator("#phase-a").click();
      expect(await frame.locator("#phase-a").innerText()).toBe("a:true");

      // Switch from a.test to b.test in the same iframe. Chromium may attach
      // the new RenderFrameHost before detaching the old session.
      await frame.locator("#swap").click();
      await frame.locator("#phase-b").waitFor({ state: "visible", timeout: 15_000 });
      await frame.locator("#phase-b").click();
      expect(await frame.locator("#phase-b").innerText()).toBe("b:true");

      // The new OOPIF also contains a same-origin nested iframe. This proves
      // routing can cross one process boundary and then continue locally.
      const nested = frame.frameLocator("#nested-frame");
      await nested.locator("#nested-button").waitFor({ state: "visible", timeout: 15_000 });
      await nested.locator("#nested-button").click();
      expect(await nested.locator("#nested-button").innerText()).toBe("nested:true");

      await browserWorker.closeContext("oopif-flat-session-integration");
      expect((await browserWorker.health()).activeContexts).toBe(0);
    } finally {
      await browserWorker.shutdown().catch(() => undefined);
      await closeServer(parentServer);
      await closeServer(childServer);
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
