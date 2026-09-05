import * as readline from "readline";
import type { BrowserWorkerRequest, BrowserWorkerResponse } from "./protocol";
import type { AresProfile } from "../profiles/models";
import type { CheckoutPaymentSession, PaymentPreparationResult } from "../payments/models";
import type { RuntimeShop } from "./runtime-types";
import type { PatchrightShopifyTaskExecutor as ShopifyExecutorType } from "../shopify/patchright-shopify-executor";
import type { EarlyGateBrowserTaskExecutor as EarlyGateExecutorType } from "./early-gate-task-executor";
import type { AresBrowserRuntime as BrowserCoreType } from "./ares-browser-runtime";
import type { PokemonCenterReleaseJourney as PokemonCenterJourneyType } from "../commerce/pokemon-center/release-journey";
import { ShopifyPaymentPreparer } from "../shopify/payment-preparer";
import { isEarlyGateChildTask } from "../monitor/early-gate";
import { isShopifyRuntimeShop } from "./runtime-types";

const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
if (nodeMajor < 20) {
  process.stderr.write(`ARES Browser Worker benötigt Node.js 20 oder höher; gefunden: ${process.versions.node}.\n`);
  process.exit(20);
}

const { AresBrowserRuntime } = require("./ares-browser-runtime") as { AresBrowserRuntime: typeof BrowserCoreType; };
const { PatchrightShopifyTaskExecutor } = require("../shopify/patchright-shopify-executor") as { PatchrightShopifyTaskExecutor: typeof ShopifyExecutorType; };
const { EarlyGateBrowserTaskExecutor } = require("./early-gate-task-executor") as { EarlyGateBrowserTaskExecutor: typeof EarlyGateExecutorType; };
const { PokemonCenterReleaseJourney } = require("../commerce/pokemon-center/release-journey") as { PokemonCenterReleaseJourney: typeof PokemonCenterJourneyType; };

function send(message: BrowserWorkerResponse): void { process.stdout.write(`${JSON.stringify(message)}\n`); }

const shops = new Map<string, RuntimeShop>();
const profiles = new Map<string, AresProfile>();
const browserCore = new AresBrowserRuntime();
const paymentPreparer = new ShopifyPaymentPreparer();
const pokemonCenterJourney = new PokemonCenterReleaseJourney();

function stampProfileOwnedBrowserSession(task: any): void {
  const handle = browserCore.getContext(task.id);
  const profileId = browserCore.getBoundProfileId(task.id);
  if (!handle || !profileId) return;
  const current = task.config?.data?.["browserSession"] as Record<string, unknown> | undefined;
  task.config.data = {
    ...(task.config.data ?? {}),
    browserSession: {
      ...(current ?? {}),
      type: "ares-browser-runtime",
      engine: browserCore.engine,
      profileId,
      isolatedPerTask: false,
      isolatedPerProfile: true,
      userDataDir: handle.userDataDir
    }
  };
}

const emitTaskUpdate = (task: any) => {
  stampProfileOwnedBrowserSession(task);
  send({ type: "task-update", taskId: task.id, taskPatch: { config: task.config, lastError: task.lastError } });
};

const shopifyExecutor = new PatchrightShopifyTaskExecutor(
  shopId => { const shop = shops.get(shopId); return shop && isShopifyRuntimeShop(shop) ? shop : undefined; },
  profileId => profiles.get(profileId), browserCore, undefined, emitTaskUpdate
);
const earlyGateExecutor = new EarlyGateBrowserTaskExecutor(
  shopId => shops.get(shopId), profileId => profiles.get(profileId),
  shop => pokemonCenterJourney.supports(shop) ? pokemonCenterJourney : undefined,
  browserCore, emitTaskUpdate
);

function takePaymentSession(request: Extract<BrowserWorkerRequest, { type: "execute" }>): CheckoutPaymentSession | undefined {
  const data = { ...(request.task.config.data ?? {}) };
  const session = data["__paymentSession"] as CheckoutPaymentSession | undefined;
  delete data["__paymentSession"];
  request.task.config = { ...request.task.config, data };
  return session;
}

async function preparePayment(request: Extract<BrowserWorkerRequest, { type: "execute" }>, session: CheckoutPaymentSession | undefined): Promise<void> {
  const page = browserCore.getContext(request.task.id)?.page;
  if (!page) return;
  let paymentPreparation: PaymentPreparationResult;
  try { paymentPreparation = await paymentPreparer.prepare(page, session); }
  catch (error) {
    paymentPreparation = {
      detectedMethods: [], selectedMethod: session?.method, filledFields: [], missingFields: [], requiresUserAction: true,
      note: `Zahlungsprüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  request.task.config.data = { ...(request.task.config.data ?? {}), paymentPreparation };
  emitTaskUpdate(request.task);
}

async function handle(request: BrowserWorkerRequest): Promise<void> {
  try {
    if (request.type === "execute") {
      const paymentSession = takePaymentSession(request);
      shops.set(request.shop.id, request.shop);
      profiles.set(request.profile.id, request.profile);
      browserCore.bindTaskProfile(request.task.id, request.profile.id);
      browserCore.setTaskCookieSnapshot(request.task.id, request.cookieSnapshot);

      try {
        const earlyGate = isEarlyGateChildTask(request.task);
        if (!earlyGate && !isShopifyRuntimeShop(request.shop)) throw new Error(`Für ${request.shop.platform} ist kein regulärer Browser-Executor registriert.`);
        const success = earlyGate ? await earlyGateExecutor.execute(request.task, paymentSession) : await shopifyExecutor.execute(request.task);
        if (success && !earlyGate) await preparePayment(request, paymentSession);
        stampProfileOwnedBrowserSession(request.task);
        request.task.config.data = {
          ...(request.task.config.data ?? {}),
          browserWorker: {
            pid: process.pid,
            nodeVersion: process.versions.node,
            externalProcess: true,
            runtime: browserCore.runtimeId,
            engine: browserCore.engine
          }
        };
        await browserCore.closeContext(request.task.id).catch(() => undefined);
        browserCore.unbindTaskProfile(request.task.id);
        send({ type: "execute-result", requestId: request.requestId, success, taskPatch: { config: request.task.config, lastError: request.task.lastError } });
        return;
      } catch (error) {
        await browserCore.closeContext(request.task.id).catch(() => undefined);
        browserCore.unbindTaskProfile(request.task.id);
        throw error;
      }
    }

    if (request.type === "update-discovery-keywords") {
      const keywords = await earlyGateExecutor.updateDiscoveryKeywords(request.taskId, request.keywords);
      send({ type: "ack", requestId: request.requestId, keywords }); return;
    }
    if (request.type === "set-final-purchase-permission") {
      await earlyGateExecutor.setFinalPurchaseAllowed(request.allowed === true);
      send({ type: "ack", requestId: request.requestId, allowFinalPurchase: request.allowed === true }); return;
    }
    if (request.type === "cancel") {
      await Promise.allSettled([earlyGateExecutor.cancelTask(request.taskId), shopifyExecutor.closeTask(request.taskId)]);
      browserCore.unbindTaskProfile(request.taskId);
      send({ type: "ack", requestId: request.requestId }); return;
    }
    if (request.type === "health") {
      const health = await browserCore.health();
      send({
        type: "health-result",
        requestId: request.requestId,
        health: { ...health, startedAt: health.startedAt.toISOString() },
        pid: process.pid,
        nodeVersion: process.versions.node
      }); return;
    }
    if (request.type === "shutdown") {
      await earlyGateExecutor.setFinalPurchaseAllowed(false);
      await earlyGateExecutor.closeAll();
      await shopifyExecutor.closeAll();
      send({ type: "ack", requestId: request.requestId });
      setImmediate(() => process.exit(0)); return;
    }
    send({ type: "error", requestId: (request as { requestId?: string }).requestId, error: `Unbekannter Anfragetyp: ${(request as { type: string }).type}` });
  } catch (error) {
    send({ type: "error", requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", line => {
  if (!line.trim()) return;
  try { const request = JSON.parse(line) as BrowserWorkerRequest; void handle(request); }
  catch (error) { send({ type: "error", error: error instanceof Error ? error.message : String(error) }); }
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await earlyGateExecutor.setFinalPurchaseAllowed(false).catch(() => undefined);
  await earlyGateExecutor.closeAll().catch(() => undefined);
  await shopifyExecutor.closeAll().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("uncaughtException", error => { process.stderr.write(`Uncaught browser-worker error: ${error.stack ?? error.message}\n`); void shutdown(); });
process.on("unhandledRejection", reason => { process.stderr.write(`Unhandled browser-worker rejection: ${String(reason)}\n`); void shutdown(); });
send({ type: "ready", nodeVersion: process.versions.node, pid: process.pid });
