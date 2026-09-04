import * as readline from "readline";
import type { BrowserProxyConfig } from "./types";
import type { ProfileCookieSnapshotCookie } from "../cookies/profile-cookie-snapshot-vault";
import { PatchrightBrowserWorker } from "./patchright-browser-worker";

interface ManualProfileBrowserStartRequest {
  type: "start";
  profileId: string;
  userDataDir: string;
  proxy?: BrowserProxyConfig;
  userAgent?: string;
  startUrl?: string;
}

interface ManualProfileBrowserCloseRequest {
  type: "close";
}

interface ManualProfileBrowserExportCookiesRequest {
  type: "export-cookies";
  requestId: string;
}

type ManualProfileBrowserRequest =
  | ManualProfileBrowserStartRequest
  | ManualProfileBrowserCloseRequest
  | ManualProfileBrowserExportCookiesRequest;

interface ManualProfileBrowserMessage {
  type: "ready" | "cookies" | "error";
  requestId?: string;
  profileId?: string;
  pid?: number;
  userDataDir?: string;
  cookies?: ProfileCookieSnapshotCookie[];
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

async function exportCookies(requestId: string): Promise<void> {
  const handle = activeTaskId ? browser.getContext(activeTaskId) : undefined;
  if (!handle) throw new Error("Profil-Browser ist nicht geöffnet.");
  const cookies = await handle.context.cookies() as ProfileCookieSnapshotCookie[];
  send({ type: "cookies", requestId, cookies });
}

async function start(request: ManualProfileBrowserStartRequest): Promise<void> {
  if (started) throw new Error("Manual profile browser was already started.");
  started = true;

  const profileId = String(request.profileId ?? "").trim();
  const userDataDir = String(request.userDataDir ?? "").trim();
  if (!profileId || !userDataDir) throw new Error("profileId and userDataDir are required.");

  activeTaskId = `manual-profile:${profileId}`;
  browser.bindTaskProfile(activeTaskId, profileId);
  const handle = await browser.createContext({
    taskId: activeTaskId,
    userDataDir,
    headless: false,
    proxy: request.proxy,
    userAgent: request.userAgent || undefined,
    viewport: null,
    args: ["--restore-last-session"],
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
rl.on("line", line => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line) as ManualProfileBrowserRequest;
    if (request.type === "close") {
      void closeAndExit(0);
      return;
    }
    if (request.type === "export-cookies") {
      void exportCookies(request.requestId).catch(error => {
        send({
          type: "error",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return;
    }
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
