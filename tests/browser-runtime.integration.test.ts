import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { PatchrightBrowserWorker } from "../src/browser-worker/patchright-browser-worker";

const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1"
  ? describe
  : describe.skip;

type JsonMessage = Record<string, unknown>;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function collectJsonLines(child: ChildProcessWithoutNullStreams): {
  messages: JsonMessage[];
  stderr: () => string;
} {
  const messages: JsonMessage[] = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdoutBuffer += String(chunk);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as JsonMessage);
      } catch {
        // Ignore non-protocol stdout. The production client does the same.
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderrBuffer = `${stderrBuffer}${String(chunk)}`.slice(-12_000);
  });

  return { messages, stderr: () => stderrBuffer };
}

async function waitForMessage(
  messages: JsonMessage[],
  predicate: (message: JsonMessage) => boolean,
  timeoutMs = 10_000
): Promise<JsonMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await delay(25);
  }
  throw new Error(`Timed out waiting for browser-worker message. Seen: ${JSON.stringify(messages)}`);
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("Browser worker did not exit after shutdown."));
    }, timeoutMs);

    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };

    child.once("exit", onExit);
  });
}

describeBrowserIntegration("real browser runtime integration", () => {
  jest.setTimeout(60_000);

  it("spawns the compiled production worker and completes ready -> health -> shutdown RPC", async () => {
    const workerScript = path.resolve(__dirname, "../dist/backend/browser-worker/worker.js");
    const child = spawn(process.execPath, [workerScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ARES_BROWSER_WORKER: "1" }
    });
    const output = collectJsonLines(child);

    try {
      const ready = await waitForMessage(output.messages, message => message["type"] === "ready");
      expect(Number(ready["pid"])).toBeGreaterThan(0);
      expect(String(ready["nodeVersion"])).toMatch(/^\d+\./);

      child.stdin.write(`${JSON.stringify({ type: "health", requestId: "integration-health" })}\n`);
      const health = await waitForMessage(
        output.messages,
        message => message["type"] === "health-result" && message["requestId"] === "integration-health"
      );
      const healthPayload = health["health"] as JsonMessage;
      expect(health["pid"]).toBe(ready["pid"]);
      expect(healthPayload["state"]).toBe("healthy");
      expect(healthPayload["activeContexts"]).toBe(0);

      child.stdin.write(`${JSON.stringify({ type: "shutdown", requestId: "integration-shutdown" })}\n`);
      await waitForMessage(
        output.messages,
        message => message["type"] === "ack" && message["requestId"] === "integration-shutdown"
      );
      await waitForExit(child);
      expect(child.exitCode).toBe(0);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nworker stderr:\n${output.stderr()}`);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
    }
  });

  it("launches a real Patchright Chrome context, loads a local page and cleans it up", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>ARES Browser Smoke</title></head><body><main id=\"status\">browser-ok</main></body></html>");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/smoke`;
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ares-browser-integration-"));
    const browserWorker = new PatchrightBrowserWorker();

    try {
      const handle = await browserWorker.createContext({
        taskId: "browser-runtime-integration",
        userDataDir,
        headless: true,
        viewport: null,
        navigationTimeoutMs: 15_000,
        actionTimeoutMs: 5_000
      });

      const response = await handle.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      expect(response?.ok()).toBe(true);
      expect(await handle.page.title()).toBe("ARES Browser Smoke");
      expect(await handle.page.locator("#status").textContent()).toBe("browser-ok");

      const health = await browserWorker.health();
      expect(health.state).toBe("healthy");
      expect(health.activeContexts).toBe(1);
      expect(health.contextIds).toEqual(["browser-runtime-integration"]);

      await browserWorker.closeContext("browser-runtime-integration");
      const afterClose = await browserWorker.health();
      expect(afterClose.activeContexts).toBe(0);
    } finally {
      await browserWorker.shutdown().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
