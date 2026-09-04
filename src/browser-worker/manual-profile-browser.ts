import * as readline from "readline";
import type { BrowserProxyConfig } from "./types";
import { PatchrightBrowserWorker } from "./patchright-browser-worker";

interface ManualProfileBrowserStartRequest {
  type: "start";
  profileId: string;
  userDataDir: string;
  proxy?: BrowserProxyConfig;
  userAgent?: string;
  startUrl?: string;
}

interface ManualProfileBrowserMessage {
  type: "ready" | "error";
  profileId?: string;
  pid?: number;
  userDataDir?: string;
  error?: string;
}

function send(message: ManualProfileBrowserMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const browser = new PatchrightBrowserWorker();
let activeTaskId = "";
let started = false;
let shuttingDown = false;

async function closeAndExit(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (activeTaskId) await browser.closeContext(activeTaskId).catch(() => undefined);
  await browser.shutdown().catch(() => undefined);
  process.exit(code);
}

async function start(request: ManualProfileBrowserStartRequest): Promise<void> {
  if (started) throw new Error("Manual profile browser was already started.");
  started = true;

  const profileId = String(request.profileId ?? "").trim();
  const userDataDir = String(request.userDataDir ?? "").trim();
  if (!profileId || !userDataDir) throw new Error("profileId and userDataDir are required.");

  activeTaskId = `manual-profile:${profileId}`;
  const handle = await browser.createContext({
    taskId: activeTaskId,
    userDataDir,
    headless: false,
    proxy: request.proxy,
    userAgent: request.userAgent || undefined,
    viewport: null,
    navigationTimeoutMs: 30_000,
    actionTimeoutMs: 15_000
  });

  if (request.startUrl?.trim()) {
    await handle.page.goto(request.startUrl.trim(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    }).catch(() => undefined);
  }

  handle.context.on("close", () => void closeAndExit(0));
  send({
    type: "ready",
    profileId,
    pid: process.pid,
    userDataDir: handle.userDataDir
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.once("line", line => {
  if (!line.trim()) {
    void closeAndExit(1);
    return;
  }
  try {
    const request = JSON.parse(line) as ManualProfileBrowserStartRequest;
    if (request.type !== "start") throw new Error("Unknown manual profile browser request.");
    void start(request).catch(error => {
      send({ type: "error", error: error instanceof Error ? error.message : String(error) });
      void closeAndExit(1);
    });
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : String(error) });
    void closeAndExit(1);
  }
});

process.on("SIGTERM", () => void closeAndExit(0));
process.on("SIGINT", () => void closeAndExit(0));
process.on("uncaughtException", error => {
  send({ type: "error", error: error.message });
  void closeAndExit(1);
});
process.on("unhandledRejection", reason => {
  send({ type: "error", error: String(reason) });
  void closeAndExit(1);
});