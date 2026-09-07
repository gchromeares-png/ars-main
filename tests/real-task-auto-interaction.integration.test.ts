import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { CommerceShop } from "../src/commerce/platforms";
import { CommerceTaskExecutorRouter } from "../src/commerce/task-executor-router";
import { TaskRepositoryMock, WorkerMock } from "../src/mocks";
import { TaskState } from "../src/models";
import { TaskOrchestrator } from "../src/orchestrator";
import { EphemeralPaymentExecutor } from "../src/payments/ephemeral-payment-executor";
import type { AresProfile } from "../src/profiles/models";

const { BrowserWorkerPoolClient } = require(
  path.join(process.cwd(), "dist/backend/browser-worker/client.js")
) as typeof import("../src/browser-worker/client");

const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1"
  ? describe
  : describe.skip;

type SolveHit = {
  type: "frame-loaded" | "solved" | "failed";
  trusted: string;
  fraction: string;
};

type FixtureServers = {
  main: http.Server;
  frame: http.Server;
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function findNamedFile(root: string, name: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = await findNamedFile(candidate, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function fixtureServers(hits: SolveHit[]): FixtureServers {
  const send = (response: http.ServerResponse, body: string, contentType = "text/html; charset=utf-8") => {
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  };

  const frame = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/frame-loaded") {
      hits.push({ type: "frame-loaded", trusted: "", fraction: "" });
      send(response, "ok", "text/plain; charset=utf-8");
      return;
    }
    if (url.pathname === "/solved" || url.pathname === "/failed") {
      hits.push({
        type: url.pathname === "/solved" ? "solved" : "failed",
        trusted: url.searchParams.get("trusted") || "",
        fraction: url.searchParams.get("fraction") || ""
      });
      send(response, "ok", "text/plain; charset=utf-8");
      return;
    }

    send(response, `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#fff;font-family:Arial,sans-serif}
      #mount{padding:18px}
      #slider-fixture{width:430px;border:1px solid #bbb;padding:16px;background:#fff}
      #instruction{font-size:18px;margin:0 0 12px}
      #track{position:relative;width:320px;height:44px;background:#e8e8e8;border:1px solid #aaa;user-select:none}
      #handle{position:absolute;left:0;top:0;width:44px;height:44px;background:#d7d7d7;cursor:grab;box-sizing:border-box}
      #status{margin-top:9px;height:20px}
    </style></head><body><div id="mount">Rätsel wird geladen …</div><script>
    (() => {
      fetch('/frame-loaded').catch(() => undefined);
      setTimeout(() => {
        const mount = document.getElementById('mount');
        mount.innerHTML = '<div id="slider-fixture">' +
          '<div id="instruction">Ziehe den Regler nach rechts bis zum Ende.</div>' +
          '<div id="track" class="slider-track"><div id="handle" class="slider-handle" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div></div>' +
          '<div id="status">Noch nicht abgeschlossen</div></div>';
        const track = document.getElementById('track');
        const handle = document.getElementById('handle');
        const status = document.getElementById('status');
        let dragging = false;
        let downTrusted = false;
        let fraction = 0;
        const update = clientX => {
          const rect = track.getBoundingClientRect();
          fraction = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
          handle.style.left = Math.max(0, Math.min(rect.width - handle.offsetWidth, fraction * rect.width - handle.offsetWidth / 2)) + 'px';
          handle.setAttribute('aria-valuenow', String(fraction * 100));
        };
        handle.addEventListener('mousedown', event => {
          dragging = true;
          downTrusted = event.isTrusted === true;
          update(event.clientX);
          event.preventDefault();
        });
        document.addEventListener('mousemove', event => { if (dragging) update(event.clientX); });
        document.addEventListener('mouseup', event => {
          if (!dragging) return;
          update(event.clientX);
          dragging = false;
          const trusted = downTrusted && event.isTrusted === true;
          if (trusted && fraction >= 0.94) {
            status.textContent = 'Abgeschlossen';
            const done = document.createElement('div');
            done.id = 'done';
            done.hidden = true;
            document.getElementById('slider-fixture').appendChild(done);
            fetch('/solved?trusted=' + encodeURIComponent(String(trusted)) + '&fraction=' + encodeURIComponent(fraction.toFixed(6)));
          } else {
            status.textContent = 'Nicht abgeschlossen';
            fetch('/failed?trusted=' + encodeURIComponent(String(trusted)) + '&fraction=' + encodeURIComponent(fraction.toFixed(6)));
          }
        });
      }, 700);
    })();
    </script></body></html>`);
  });

  const main = http.createServer((_request, response) => {
    const address = frame.address() as AddressInfo;
    const frameUrl = `http://127.0.0.1:${address.port}/frame`;
    send(response, `<!doctype html><html><head><title>ARES Task Runtime Fixture</title></head><body>
      <main id="root">Produktseite bereit</main>
      <iframe id="puzzle-frame" src=${JSON.stringify(frameUrl)} style="width:520px;height:220px;border:0"></iframe>
    </body></html>`);
  });

  return { main, frame };
}

const profile: AresProfile = {
  id: "runtime-e2e-profile",
  name: "Runtime E2E",
  contact: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test"
  },
  address: {
    address1: "Teststrasse 1",
    postalCode: "10115",
    city: "Berlin",
    countryCode: "DE"
  },
  browser: { headless: true }
};

describeBrowserIntegration("real task auto-interaction wiring", () => {
  jest.setTimeout(150_000);

  it("drives a delayed cross-origin slider from TaskOrchestrator through the production worker to trusted CDP input", async () => {
    const hits: SolveHit[] = [];
    let stage = "fixture-start";
    const setStage = (next: string): void => {
      stage = next;
      process.stderr.write(`[ARES_GLUE_STAGE] ${stage}\n`);
    };
    const servers = fixtureServers(hits);
    await new Promise<void>((resolve, reject) => {
      servers.frame.once("error", reject);
      servers.frame.listen(0, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      servers.main.once("error", reject);
      servers.main.listen(0, "127.0.0.1", () => resolve());
    });

    const address = servers.main.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "ares-real-task-runtime-"));
    const shop: CommerceShop = {
      id: "runtime-e2e-shop",
      name: "Runtime E2E Shop",
      baseUrl,
      platform: "custom",
      config: {}
    };

    const browserWorker = new BrowserWorkerPoolClient(
      shopId => shopId === shop.id ? shop : undefined,
      profileId => profileId === profile.id ? profile : undefined,
      {
        processCount: 1,
        requestTimeoutMs: 45_000,
        executeTimeoutMs: 120_000,
        heartbeatIntervalMs: 0,
        profileRoot
      }
    );
    const paymentAware = new EphemeralPaymentExecutor(browserWorker, () => undefined);
    const router = new CommerceTaskExecutorRouter(shopId => shopId === shop.id ? shop : undefined);
    router.registerEarlyGateExecutor(paymentAware);
    await router.setFinalPurchaseAllowed(false);

    const orchestrator = new TaskOrchestrator(new TaskRepositoryMock(), router);
    orchestrator.addWorker(new WorkerMock("browser-slot-runtime-e2e"));
    const task = orchestrator.createTask({
      id: "real-task-auto-interaction-e2e",
      name: "Real Task Auto Interaction E2E",
      shopId: shop.id,
      maxRetries: 0,
      data: {
        profileId: profile.id,
        proxySelection: { mode: "direct" },
        browserConfig: { headless: true },
        monitorStrategy: {
          mode: "early-gate",
          productName: "Exam Fixture",
          discoveryKeywords: ["exam", "fixture"]
        },
        monitorAction: {
          mode: "auto-checkout",
          profileId: profile.id,
          headless: true,
          proxySelection: { mode: "direct" }
        }
      }
    });

    const run = orchestrator.startTask(task.id);
    let mainCompleted = false;
    let cleanupError: Error | undefined;
    try {
      setStage("runtime-ready");
      await waitFor(
        () => {
          if (task.state === TaskState.FAILED) {
            throw new Error(`Task failed before browser runtime became ready: ${task.lastError || "unknown error"}`);
          }
          return task.config.data?.["browserGateMonitor"] ? true : undefined;
        },
        50_000,
        `browser runtime readiness; state=${task.state}; lastError=${task.lastError || ""}`
      );
      expect(task.config.data?.["browserSession"]).toMatchObject({
        type: "ares-browser-runtime",
        engine: "seleniumbase-cdp",
        profileId: profile.id,
        isolatedPerProfile: true
      });

      setStage("iframe-loaded");
      await waitFor(
        () => {
          if (task.state === TaskState.FAILED) {
            throw new Error(`Task failed before cross-origin iframe load: ${task.lastError || "unknown error"}`);
          }
          return hits.find(hit => hit.type === "frame-loaded");
        },
        10_000,
        `cross-origin iframe load after runtime ready; state=${task.state}; hits=${JSON.stringify(hits)}`
      );

      setStage("automatic-slider-solve");
      const solved = await waitFor(
        () => {
          if (task.state === TaskState.FAILED) {
            throw new Error(`Task failed before automatic slider solve: ${task.lastError || "unknown error"}`);
          }
          return hits.find(hit => hit.type === "solved");
        },
        50_000,
        `trusted automatic slider solve after frame load; state=${task.state}; hits=${JSON.stringify(hits)}`
      );

      expect(solved.trusted).toBe("true");
      expect(Number(solved.fraction)).toBeGreaterThanOrEqual(0.94);
      expect(task.state).toBe(TaskState.RUNNING);
      expect(task.config.data?.["browserGateMonitor"]).toMatchObject({ mode: "browser", profileId: profile.id });
      mainCompleted = true;
    } finally {
      const fromStage = stage;
      setStage("cleanup-cancel");
      orchestrator.cancelTask(task.id);
      await withTimeout(
        run.catch(() => undefined),
        10_000,
        `task execution cancellation; from=${fromStage}; state=${task.state}; hits=${JSON.stringify(hits)}`
      ).catch(error => { cleanupError = error instanceof Error ? error : new Error(String(error)); });
      orchestrator.cleanup();

      setStage("cleanup-router");
      await withTimeout(
        router.close(),
        10_000,
        `browser router close; from=${fromStage}; state=${task.state}`
      ).catch(error => { cleanupError ??= error instanceof Error ? error : new Error(String(error)); });

      setStage("cleanup-servers");
      await withTimeout(
        Promise.all([closeServer(servers.main), closeServer(servers.frame)]),
        5_000,
        `fixture server close; from=${fromStage}`
      ).catch(error => { cleanupError ??= error instanceof Error ? error : new Error(String(error)); });

      if (mainCompleted && cleanupError) throw cleanupError;
    }

    setStage("trace-verification");
    const visualTrace = await findNamedFile(profileRoot, ".ares-visual-trace.jsonl");
    expect(visualTrace).toBeDefined();
    if (visualTrace) {
      const trace = await readFile(visualTrace, "utf8");
      expect(trace).toContain('"kind":"slider"');
      expect(trace).toMatch(/:cdp/);
    }

    expect(hits.filter(hit => hit.type === "frame-loaded")).toHaveLength(1);
    expect(hits.filter(hit => hit.type === "solved")).toHaveLength(1);
    expect(hits.filter(hit => hit.type !== "frame-loaded").every(hit => hit.trusted === "true")).toBe(true);
    await rm(profileRoot, { recursive: true, force: true });
  });

  it("keeps every user-facing Chrome entry point on the same control-aware automatic runtime contract", async () => {
    const [manual, monitor, taskWorker, browserWorker] = await Promise.all([
      readFile(path.join(process.cwd(), "python/seleniumbase_cdp/manual_profile_browser.py"), "utf8"),
      readFile(path.join(process.cwd(), "python/seleniumbase_cdp/product_monitor_browser.py"), "utf8"),
      readFile(path.join(process.cwd(), "python/seleniumbase_cdp/task_browser_worker_oopif.py"), "utf8"),
      readFile(path.join(process.cwd(), "src/browser-worker/seleniumbase-browser-worker.ts"), "utf8")
    ]);

    expect(manual).toContain("ControlAwareSeleniumBaseCdpAdapter");
    expect(manual).toContain("_enable_oopif_runtime(adapter)");
    expect(manual).toContain("adapter.poll_runtime()");
    expect(monitor).toContain("ControlAwareSeleniumBaseCdpAdapter");
    expect(monitor).toContain("adapter.poll_runtime()");
    expect(taskWorker).toContain("impl.base.SeleniumBaseCdpAdapter = ControlAwareSeleniumBaseCdpAdapter");
    expect(taskWorker).toContain("impl.base.run = _seeded_run");
    expect(browserWorker.indexOf("task_browser_worker_oopif.py")).toBeLessThan(browserWorker.indexOf("task_browser_worker.py"));
  });
});
