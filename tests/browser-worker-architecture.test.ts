import * as fs from "fs";
import * as path from "path";

describe("external Node browser worker architecture", () => {
  const client = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/client.ts"), "utf8");
  const protocol = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/protocol.ts"), "utf8");
  const worker = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/worker.ts"), "utf8");
  const contract = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/browser-worker.ts"), "utf8");
  const runtime = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/ares-browser-runtime.ts"), "utf8");
  const seleniumWorker = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/seleniumbase-browser-worker.ts"), "utf8");
  const rpcPage = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/seleniumbase-rpc-page.ts"), "utf8");

  it("exposes createContext, closeContext and health as the browser-core contract", () => {
    expect(contract).toContain("createContext(config: BrowserContextConfig)");
    expect(contract).toContain("closeContext(taskId: string)");
    expect(contract).toContain("health(): Promise<BrowserWorkerHealth>");
  });

  it("routes task browser ownership through the central SeleniumBase ARES runtime boundary", () => {
    expect(worker).toContain('require("./ares-browser-runtime")');
    expect(worker).toContain("new AresBrowserRuntime()");
    expect(runtime).toContain("class AresBrowserRuntime");
    expect(runtime).toContain('engine = "seleniumbase-cdp"');
    expect(runtime).toContain("extends SeleniumBaseBrowserWorker");
    expect(seleniumWorker).toContain("class SeleniumBaseBrowserWorker");
  });

  it("keeps locator construction lazy and defers RPC until a real operation", () => {
    expect(rpcPage).toContain("constructing this object performs zero RPC calls");
    expect(rpcPage).toContain("locatorOperation(");
    expect(rpcPage).toContain('this.op("click"');
    expect(rpcPage).toContain('this.op("fill"');
  });

  it("runs browser executors only after a Node 20+ worker runtime gate", () => {
    expect(worker).toContain("if (nodeMajor < 20)");
  });

  it("provides a resource-conscious process pool and task ownership routing", () => {
    expect(client).toContain("BrowserWorkerPoolClient");
    expect(client).toContain('ARES_BROWSER_WORKER_PROCESSES ?? "1"');
    expect(client).toContain("leastLoadedClient");
    expect(client).toContain("taskOwners");
    expect(client).toContain('process.env.ARES_NODE_EXECUTABLE?.trim() || "node"');
  });

  it("supports worker health over the JSON-line RPC protocol", () => {
    expect(protocol).toContain('type: "health"');
    expect(protocol).toContain('type: "health-result"');
    expect(worker).toContain("const health = await browserCore.health()");
    expect(worker).toContain("startedAt: health.startedAt.toISOString()");
  });

  it("routes task cancellation through the executor contract", () => {
    const interfaces = fs.readFileSync(path.resolve(__dirname, "../src/interfaces/index.ts"), "utf8");
    const orchestrator = fs.readFileSync(path.resolve(__dirname, "../src/orchestrator/index.ts"), "utf8");
    const electronMain = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");

    expect(interfaces).toContain("cancelTask?(taskId: string): Promise<void>");
    expect(orchestrator).toContain("this.executor.cancelTask?.(taskId)");
    expect(electronMain).not.toContain("await browserWorker.cancelTask(taskId)");
  });

  it("keeps concrete browser runtime imports outside Electron main", () => {
    const electronMain = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");
    expect(electronMain).not.toContain('from "patchright"');
    expect(electronMain).not.toContain('require("patchright")');
    expect(electronMain).toContain('from "../browser-worker/client"');
  });

  it("performs graceful async executor shutdown before Electron exits", () => {
    const clientSource = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/client.ts"), "utf8");
    const routerSource = fs.readFileSync(path.resolve(__dirname, "../src/commerce/task-executor-router.ts"), "utf8");
    const electronMain = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");

    expect(clientSource).toContain("async close(): Promise<void>");
    expect(clientSource).toContain('type: "shutdown"');
    expect(routerSource).toContain("async close(): Promise<void>");
    expect(routerSource).toContain("await executor.close?.()");
    expect(electronMain).toContain("event.preventDefault()");
    expect(electronMain).toContain("await commerceExecutor?.close()");
  });
});
