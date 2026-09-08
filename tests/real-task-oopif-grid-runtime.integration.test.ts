import { mkdtemp, readFile, readdir, rm } from "fs/promises";
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

const EXPECTED = [1, 4, 7];
const TASK_ID = "real-task-oopif-grid-runtime-e2e";

type Hit = {
  type: "frame-loaded" | "solved" | "failed";
  trusted: string;
  selected: string;
  clicks: string;
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(80);
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
  if (!server.listening) return;
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 2_000);
    timer.unref();
    server.close(finish);
    server.closeIdleConnections?.();
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

async function waitForTrace(
  root: string,
  predicate: (trace: string) => boolean,
  timeoutMs: number,
  label: string
): Promise<{ path: string; trace: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tracePath = await findNamedFile(root, ".ares-visual-trace.jsonl");
    if (tracePath) {
      const trace = await readFile(tracePath, "utf8").catch(() => "");
      if (predicate(trace)) return { path: tracePath, trace };
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function logRuntimeFailureEvidence(profileRoot: string, hits: Hit[], visionCalls: number): Promise<void> {
  const tracePath = await findNamedFile(profileRoot, ".ares-visual-trace.jsonl");
  const trace = tracePath ? await readFile(tracePath, "utf8").catch(() => "") : "";
  const tail = trace.split(/\r?\n/).filter(Boolean).slice(-40).join("\n");
  console.error(`[OOPIF-RUNTIME-EVIDENCE] visionCalls=${visionCalls} hits=${JSON.stringify(hits)} tracePath=${tracePath ?? "missing"}`);
  if (tail) console.error(`[OOPIF-RUNTIME-TRACE-TAIL]\n${tail}`);
}

function send(response: http.ServerResponse, body: string, type = "text/html; charset=utf-8"): void {
  response.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function createVisionServer(): { server: http.Server; token: string; calls: () => number } {
  const token = "runtime-grid-e2e-token";
  let callCount = 0;
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      send(response, JSON.stringify({ ready: true, model: "runtime-grid-e2e" }), "application/json");
      return;
    }
    if (request.method !== "POST" || request.url !== "/classify") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        instruction?: string;
        sources?: string[];
      };
      if (!String(payload.instruction ?? "").toLowerCase().includes("fahrr")) {
        response.writeHead(422).end("instruction mismatch");
        return;
      }
      if (!Array.isArray(payload.sources) || payload.sources.length !== 9 || !payload.sources.every(source => source.startsWith("data:image/png;base64,"))) {
        response.writeHead(422).end("crop mismatch");
        return;
      }
      callCount += 1;
      send(response, JSON.stringify({
        selectedIndexes: EXPECTED,
        scores: [0.1, 0.9, 0.1, 0.1, 0.95, 0.1, 0.1, 0.92, 0.1],
        rawLogits: [-2, 2, -2, -2, 2.2, -2, -2, 2.1, -2],
        model: "runtime-grid-e2e",
        target: "fahrräder",
        threshold: 0.5,
        selectionPolicy: "runtime-grid-e2e"
      }), "application/json");
    });
  });
  return { server, token, calls: () => callCount };
}

function createFixtureServers(hits: Hit[]): { main: http.Server; frame: http.Server } {
  const frame = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/frame-loaded") {
      hits.push({ type: "frame-loaded", trusted: "", selected: "", clicks: "" });
      send(response, "ok", "text/plain; charset=utf-8");
      return;
    }
    if (url.pathname === "/solved" || url.pathname === "/failed") {
      hits.push({
        type: url.pathname === "/solved" ? "solved" : "failed",
        trusted: url.searchParams.get("trusted") || "",
        selected: url.searchParams.get("selected") || "",
        clicks: url.searchParams.get("clicks") || ""
      });
      send(response, "ok", "text/plain; charset=utf-8");
      return;
    }

    send(response, `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#fff;font-family:Arial,sans-serif}
      main{padding:28px;width:420px}
      p{font-size:20px;margin:0 0 18px}
      section{display:grid;grid-template-columns:repeat(3,112px);gap:10px}
      section>div{width:112px;height:112px;border-radius:8px;box-shadow:inset 0 0 0 1px #888;cursor:pointer}
      section>div:nth-child(1){background:linear-gradient(135deg,#ddd,#999)}
      section>div:nth-child(2){background:linear-gradient(135deg,#2f7d32,#9ccc65)}
      section>div:nth-child(3){background:linear-gradient(135deg,#b0bec5,#607d8b)}
      section>div:nth-child(4){background:linear-gradient(135deg,#ffcc80,#ef6c00)}
      section>div:nth-child(5){background:linear-gradient(135deg,#388e3c,#c5e1a5)}
      section>div:nth-child(6){background:linear-gradient(135deg,#90caf9,#1565c0)}
      section>div:nth-child(7){background:linear-gradient(135deg,#ce93d8,#7b1fa2)}
      section>div:nth-child(8){background:linear-gradient(135deg,#43a047,#dcedc8)}
      section>div:nth-child(9){background:linear-gradient(135deg,#ef9a9a,#c62828)}
      section>div[data-selected="1"]{outline:5px solid #111;outline-offset:-5px}
      button{margin-top:18px;width:150px;height:48px;font-size:17px}
      strong{display:block;margin-top:18px;font-size:20px}
    </style></head><body><main>
      <p>Wähle alle Bilder mit Fahrrädern aus</p>
      <section><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div></section>
      <button type="submit">Bestätigen</button>
    </main><script>
    (() => {
      fetch('/frame-loaded').catch(() => undefined);
      const expected = [1,4,7];
      const selected = new Set();
      let trustedClicks = 0;
      const tiles = Array.from(document.querySelectorAll('section > div'));
      tiles.forEach((tile, index) => tile.addEventListener('click', event => {
        if (event.isTrusted !== true) return;
        trustedClicks += 1;
        if (selected.has(index)) selected.delete(index); else selected.add(index);
        tile.dataset.selected = selected.has(index) ? '1' : '0';
      }));
      document.querySelector('button').addEventListener('click', event => {
        if (event.isTrusted !== true) return;
        trustedClicks += 1;
        const actual = Array.from(selected).sort((a,b)=>a-b);
        const ok = JSON.stringify(actual) === JSON.stringify(expected);
        if (ok) {
          const done = document.createElement('strong');
          done.textContent = 'Erfolgreich verifiziert';
          document.querySelector('main').appendChild(done);
        }
        const target = ok ? '/solved' : '/failed';
        fetch(target + '?trusted=true&selected=' + encodeURIComponent(actual.join(',')) + '&clicks=' + trustedClicks).catch(() => undefined);
      });
    })();
    </script></body></html>`);
  });

  const main = http.createServer((_request, response) => {
    const frameAddress = frame.address() as AddressInfo;
    const frameUrl = `http://localhost:${frameAddress.port}/frame`;
    send(response, `<!doctype html><html><head><title>ARES Runtime Grid</title></head><body>
      <main>Produktseite bereit</main>
      <iframe src=${JSON.stringify(frameUrl)} style="width:650px;height:650px;border:1px solid #ccc"></iframe>
    </body></html>`);
  });
  return { main, frame };
}

const profile: AresProfile = {
  id: "runtime-grid-e2e-profile",
  name: "Runtime Grid E2E",
  contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
  address: { address1: "Teststrasse 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
  browser: { headless: false }
};

describeBrowserIntegration("real task OOPIF grid runtime", () => {
  jest.setTimeout(150_000);

  it("runs TaskOrchestrator -> TS worker -> Python OOPIF runtime -> screenshot vision -> seeded CDP clicks -> verified submit", async () => {
    const hits: Hit[] = [];
    const fixtures = createFixtureServers(hits);
    const vision = createVisionServer();
    await new Promise<void>((resolve, reject) => fixtures.frame.listen(0, "localhost", () => resolve()).once("error", reject));
    await new Promise<void>((resolve, reject) => fixtures.main.listen(0, "127.0.0.1", () => resolve()).once("error", reject));
    await new Promise<void>((resolve, reject) => vision.server.listen(0, "127.0.0.1", () => resolve()).once("error", reject));

    const mainAddress = fixtures.main.address() as AddressInfo;
    const visionAddress = vision.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${mainAddress.port}/`;
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "ares-ts-oopif-grid-"));
    const previousVisionUrl = process.env["ARES_VISION_SERVICE_URL"];
    const previousVisionToken = process.env["ARES_VISION_SERVICE_TOKEN"];
    const previousVisionOffline = process.env["ARES_VISION_OFFLINE"];
    process.env["ARES_VISION_SERVICE_URL"] = `http://127.0.0.1:${visionAddress.port}`;
    process.env["ARES_VISION_SERVICE_TOKEN"] = vision.token;
    process.env["ARES_VISION_OFFLINE"] = "1";

    const shop: CommerceShop = { id: "runtime-grid-e2e-shop", name: "Runtime Grid E2E", baseUrl, platform: "custom", config: {} };
    const browserWorker = new BrowserWorkerPoolClient(
      shopId => shopId === shop.id ? shop : undefined,
      profileId => profileId === profile.id ? profile : undefined,
      { processCount: 1, requestTimeoutMs: 45_000, executeTimeoutMs: 120_000, heartbeatIntervalMs: 0, profileRoot }
    );
    const paymentAware = new EphemeralPaymentExecutor(browserWorker, () => undefined);
    const router = new CommerceTaskExecutorRouter(shopId => shopId === shop.id ? shop : undefined);
    router.registerEarlyGateExecutor(paymentAware);
    await router.setFinalPurchaseAllowed(false);
    const orchestrator = new TaskOrchestrator(new TaskRepositoryMock(), router);
    orchestrator.addWorker(new WorkerMock("browser-slot-grid-e2e"));
    const task = orchestrator.createTask({
      id: TASK_ID,
      name: "Real OOPIF Grid Runtime E2E",
      shopId: shop.id,
      maxRetries: 0,
      data: {
        profileId: profile.id,
        proxySelection: { mode: "direct" },
        browserConfig: { headless: false, args: ["--site-per-process", "--window-size=1280,900", "--force-device-scale-factor=1"] },
        monitorStrategy: { mode: "early-gate", productName: "Exam Fixture", discoveryKeywords: ["exam", "fixture"] },
        monitorAction: { mode: "auto-checkout", profileId: profile.id, headless: false, proxySelection: { mode: "direct" } }
      }
    });

    const run = orchestrator.startTask(task.id);
    let cleanupError: Error | undefined;
    try {
      await waitFor(() => task.config.data?.["browserGateMonitor"] ? true : undefined, 55_000, "browser runtime readiness");
      expect(task.config.data?.["browserSession"]).toMatchObject({ type: "ares-browser-runtime", engine: "seleniumbase-cdp", profileId: profile.id });
      await waitFor(() => hits.find(hit => hit.type === "frame-loaded"), 15_000, "cross-site iframe load");
      const solved = await waitFor(() => {
        if (task.state === TaskState.FAILED) throw new Error(task.lastError || "task failed");
        return hits.find(hit => hit.type === "solved");
      }, 60_000, "automatic OOPIF grid solve");
      expect(solved.trusted).toBe("true");
      expect(solved.selected).toBe(EXPECTED.join(","));
      expect(Number(solved.clicks)).toBeGreaterThanOrEqual(4);
      expect(vision.calls()).toBeGreaterThanOrEqual(1);

      const { trace } = await waitForTrace(
        profileRoot,
        value => value.includes('"stage":"VERIFY"') && value.includes('"verified":true'),
        5_000,
        "verified runtime trace"
      );
      expect(trace).toContain('"origin":"direct-children"');
      expect(trace).toMatch(/"scope":"oopif:/);
      expect(trace).toContain('"tileCount":9');
      expect(trace).toContain('"stage":"VISION_CALLED"');
      expect(trace).toContain('"sourceCount":9');
      expect(trace).toContain('"selectedIndexes":[1,4,7]');
      expect(trace).toContain('"phase":"cursor-click"');
      expect(trace).toContain('"seeded":true');
      expect(trace).toContain('"provider":"python-bezier:cdp"');
      expect(trace).toContain('"verified":true');
    } catch (error) {
      await logRuntimeFailureEvidence(profileRoot, hits, vision.calls());
      throw error;
    } finally {
      orchestrator.cancelTask(task.id);
      await withTimeout(run.catch(() => undefined), 12_000, "task cancellation").catch(error => {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      });
      orchestrator.cleanup();
      await withTimeout(router.close(), 12_000, "router close").catch(error => {
        cleanupError ??= error instanceof Error ? error : new Error(String(error));
      });
      await delay(500);
      await withTimeout(Promise.all([closeServer(fixtures.main), closeServer(fixtures.frame), closeServer(vision.server)]), 6_000, "fixture server close").catch(error => {
        cleanupError ??= error instanceof Error ? error : new Error(String(error));
      });
      await withTimeout(rm(profileRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }), 10_000, "profile cleanup").catch(error => {
        cleanupError ??= error instanceof Error ? error : new Error(String(error));
      });
      if (previousVisionUrl === undefined) delete process.env["ARES_VISION_SERVICE_URL"]; else process.env["ARES_VISION_SERVICE_URL"] = previousVisionUrl;
      if (previousVisionToken === undefined) delete process.env["ARES_VISION_SERVICE_TOKEN"]; else process.env["ARES_VISION_SERVICE_TOKEN"] = previousVisionToken;
      if (previousVisionOffline === undefined) delete process.env["ARES_VISION_OFFLINE"]; else process.env["ARES_VISION_OFFLINE"] = previousVisionOffline;
      if (cleanupError) throw cleanupError;
    }
  });
});