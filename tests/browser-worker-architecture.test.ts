import * as fs from "fs";
import * as path from "path";

describe("external Node browser worker architecture", () => {
  const client = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/client.ts"), "utf8");
  const protocol = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/protocol.ts"), "utf8");
  const worker = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/worker.ts"), "utf8");
  const contract = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/browser-worker.ts"), "utf8");

  it("exposes createContext, closeContext and health as the browser-core contract", () => {
    expect(contract).toContain("createContext(config: BrowserContextConfig)");
    expect(contract).toContain("closeContext(taskId: string)");
    expect(contract).toContain("health(): Promise<BrowserWorkerHealth>");
  });

  it("runs Patchright only after a Node 20+ worker runtime gate", () => {
    expect(worker).toContain("if (nodeMajor < 20)");
    expect(worker).toContain('require("./patchright-browser-worker")');
    expect(worker).toContain('require("../shopify/patchright-shopify-executor")');
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

  it("keeps Patchright runtime imports outside Electron main", () => {
    const electronMain = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");
    expect(electronMain).not.toContain('from "patchright"');
    expect(electronMain).not.toContain('require("patchright")');
    expect(electronMain).toContain('from "../browser-worker/client"');
  });

  it("performs graceful async worker-pool shutdown before Electron exits", () => {
    const clientSource = fs.readFileSync(path.resolve(__dirname, "../src/browser-worker/client.ts"), "utf8");
    const electronMain = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");

    expect(clientSource).toContain("async close(): Promise<void>");
    expect(clientSource).toContain('type: "shutdown"');
    expect(electronMain).toContain("event.preventDefault()");
    expect(electronMain).toContain("await browserWorker?.close()");
  });
});
