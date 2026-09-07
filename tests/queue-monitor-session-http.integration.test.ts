import { mkdtemp, rm } from "fs/promises";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { SeleniumBaseBrowserWorker } from "../src/browser-worker/seleniumbase-browser-worker";
import { BrowserQueueWaiter } from "../src/browser-worker/queue-waiter";
import { SessionHttpPoller } from "../src/monitor/session-http-poller";
import type { Task } from "../src/models";

const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

function task(): Task {
  const now = new Date();
  return {
    id: "session-http-chain-proof",
    state: "RUNNING" as any,
    retries: 0,
    maxRetries: 1,
    createdAt: now,
    updatedAt: now,
    config: { id: "session-http-chain-proof", name: "Session HTTP chain proof", data: {} }
  };
}

async function waitUntil<T>(read: () => T | undefined, predicate: (value: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined && predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for session-http signal");
}

describeBrowserIntegration("real session-http queue escalation", () => {
  jest.setTimeout(90_000);

  it("proves CDP cookies/UA -> curl_cffi -> TS bridge -> queue waiter -> released", async () => {
    let queueRequests = 0;
    let observedCookie = "";
    let observedUserAgent = "";

    const server = http.createServer((request, response) => {
      if (request.url === "/seed") {
        response.setHeader("Set-Cookie", "ares_session=chain-proof; Path=/; HttpOnly; SameSite=Lax");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body>seeded</body></html>");
        return;
      }
      if (request.url === "/queue/status") {
        queueRequests += 1;
        observedCookie = String(request.headers.cookie || "");
        observedUserAgent = String(request.headers["user-agent"] || "");
        response.writeHead(200, { "content-type": "application/json" });
        if (queueRequests <= 2) {
          response.end(JSON.stringify({ position: 17, ttw: 2, status: "waiting" }));
        } else {
          response.end(JSON.stringify({ status: "released" }));
        }
        return;
      }
      response.writeHead(404).end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "ares-session-http-chain-"));
    const worker = new SeleniumBaseBrowserWorker();
    const runTask = task();
    let poller: SessionHttpPoller | undefined;
    let waiter: BrowserQueueWaiter | undefined;

    try {
      const handle = await worker.createContext({
        taskId: runTask.id,
        userDataDir: root,
        headless: true,
        viewport: null,
        monitorMode: true
      });
      await handle.page.goto(`${origin}/seed`, { waitUntil: "domcontentloaded" });

      poller = new SessionHttpPoller({
        url: `${origin}/queue/status`,
        profileDir: handle.userDataDir,
        pollIntervalMs: 1_000
      });
      poller.start();

      const first = await waitUntil(
        () => poller?.getLatest(5_000),
        signal => signal.active === true && signal.position === 17
      );
      console.log(`[MONITOR_E2E] stage=session-http status=${first.statusCode} active=${first.active} pos=${first.position} cookies=${observedCookie ? "present" : "missing"}`);

      waiter = new BrowserQueueWaiter(handle.page, runTask, undefined, {
        pollIntervalMs: 250,
        releaseConfirmations: 2,
        maxWaitMs: 12_000,
        externalSignal: () => {
          const signal = poller?.getLatest(5_000);
          if (!signal) return undefined;
          return {
            active: signal.active,
            position: signal.position,
            timeToWaitSeconds: signal.timeToWaitSeconds,
            statusText: signal.statusText,
            source: "session-http"
          };
        }
      });
      waiter.start();
      const result = await waiter.waitIfQueued();

      const status = runTask.config.data?.["queueStatus"] as Record<string, unknown> | undefined;
      console.log(`[MONITOR_E2E] source=${String(status?.["source"] || "unknown")} phase=${String(status?.["phase"] || "unknown")} released=${result.released}`);

      expect(observedCookie).toContain("ares_session=chain-proof");
      expect(observedUserAgent.length).toBeGreaterThan(10);
      expect(result).toMatchObject({ detected: true, released: true });
      expect(status).toMatchObject({ active: false, phase: "released", source: "session-http", position: 17 });
      expect(queueRequests).toBeGreaterThanOrEqual(3);
    } finally {
      waiter?.stop();
      poller?.stop();
      await worker.shutdown().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
