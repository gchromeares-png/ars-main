import * as readline from "readline";
import type { BrowserWorkerRequest, BrowserWorkerResponse } from "./protocol";
import type { AresProfile } from "../profiles/models";
import type { ShopifyRuntimeShop } from "./runtime-types";
import type { PatchrightShopifyTaskExecutor as ExecutorType } from "../shopify/patchright-shopify-executor";
import type { PatchrightBrowserWorker as BrowserCoreType } from "./patchright-browser-worker";

const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
if (nodeMajor < 20) {
  process.stderr.write(`ARES Browser Worker benötigt Node.js 20 oder höher; gefunden: ${process.versions.node}.\n`);
  process.exit(20);
}

const { PatchrightBrowserWorker } = require("./patchright-browser-worker") as {
  PatchrightBrowserWorker: typeof BrowserCoreType;
};
const { PatchrightShopifyTaskExecutor } = require("../shopify/patchright-shopify-executor") as {
  PatchrightShopifyTaskExecutor: typeof ExecutorType;
};

function send(message: BrowserWorkerResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const shops = new Map<string, ShopifyRuntimeShop>();
const profiles = new Map<string, AresProfile>();
const browserCore = new PatchrightBrowserWorker();
const executor = new PatchrightShopifyTaskExecutor(
  shopId => shops.get(shopId),
  profileId => profiles.get(profileId),
  browserCore,
  undefined,
  (taskId, dataPatch) => send({ type: "task-progress", taskId, dataPatch })
);

async function handle(request: BrowserWorkerRequest): Promise<void> {
  try {
    if (request.type === "execute") {
      shops.set(request.shop.id, request.shop);
      profiles.set(request.profile.id, request.profile);
      const success = await executor.execute(request.task);
      request.task.config.data = {
        ...(request.task.config.data ?? {}),
        browserWorker: {
          pid: process.pid,
          nodeVersion: process.versions.node,
          externalProcess: true
        }
      };
      send({
        type: "execute-result",
        requestId: request.requestId,
        success,
        taskPatch: {
          config: request.task.config,
          lastError: request.task.lastError
        }
      });
      return;
    }

    if (request.type === "cancel") {
      await executor.closeTask(request.taskId);
      send({ type: "ack", requestId: request.requestId });
      return;
    }

    if (request.type === "health") {
      const health = await browserCore.health();
      send({
        type: "health-result",
        requestId: request.requestId,
        health: { ...health, startedAt: health.startedAt.toISOString() },
        pid: process.pid,
        nodeVersion: process.versions.node
      });
      return;
    }

    if (request.type === "shutdown") {
      await executor.closeAll();
      send({ type: "ack", requestId: request.requestId });
      setImmediate(() => process.exit(0));
      return;
    }

    send({
      type: "error",
      requestId: (request as { requestId?: string }).requestId,
      error: `Unbekannter Anfragetyp: ${(request as { type: string }).type}`
    });
  } catch (error) {
    send({
      type: "error",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", line => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line) as BrowserWorkerRequest;
    void handle(request);
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await executor.closeAll().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("uncaughtException", error => {
  process.stderr.write(`Uncaught browser-worker error: ${error.stack ?? error.message}\n`);
  void shutdown();
});
process.on("unhandledRejection", reason => {
  process.stderr.write(`Unhandled browser-worker rejection: ${String(reason)}\n`);
  void shutdown();
});

send({ type: "ready", nodeVersion: process.versions.node, pid: process.pid });
