import { BrowserQueueWaiter } from "../src/browser-worker/queue-waiter";
import type { Task } from "../src/models";

function task(): Task {
  const now = new Date();
  return {
    id: "monitor-escalation", state: "RUNNING" as any, retries: 0, maxRetries: 1,
    createdAt: now, updatedAt: now,
    config: { id: "monitor-escalation", name: "monitor", data: {} }
  };
}

describe("queue monitor escalation", () => {
  it("uses positive session-http signal before touching browser DOM", async () => {
    const passiveQueueSnapshot = jest.fn(async () => { throw new Error("DOM must not run"); });
    const page = { isClosed: () => false, passiveQueueSnapshot, url: () => "https://shop.test/" } as any;
    const waiter = new BrowserQueueWaiter(page, task(), undefined, {
      externalSignal: () => ({ active: true, position: 17, timeToWaitSeconds: 9, source: "session-http" })
    });
    const signal = await (waiter as any).readSignal();
    expect(signal).toMatchObject({ active: true, source: "session-http", position: 17, timeToWaitSeconds: 9 });
    expect(passiveQueueSnapshot).not.toHaveBeenCalled();
  });

  it("accepts an explicit session-http release without treating HTTP misses as releases", async () => {
    const passiveQueueSnapshot = jest.fn(async () => { throw new Error("DOM must not run"); });
    const page = { isClosed: () => false, passiveQueueSnapshot, url: () => "https://shop.test/queue" } as any;
    const waiter = new BrowserQueueWaiter(page, task(), undefined, {
      externalSignal: () => ({ active: false, authoritativeRelease: true, statusText: "released", source: "session-http" })
    });
    const signal = await (waiter as any).readSignal();
    expect(signal).toMatchObject({ active: false, source: "session-http", statusText: "released" });
    expect(passiveQueueSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to native passive DOM inspection without evaluate", async () => {
    const passiveQueueSnapshot = jest.fn(async () => ({
      hasQueuePosition: true,
      hasPosition: true,
      positionText: "<div id=\"queue-position\">42</div>",
      statusText: "<div id=\"status\">Waiting in queue</div>",
      url: "https://shop.test/"
    }));
    const evaluate = jest.fn(async () => { throw new Error("Runtime.evaluate must not run"); });
    const page = { isClosed: () => false, passiveQueueSnapshot, evaluate, url: () => "https://shop.test/" } as any;
    const waiter = new BrowserQueueWaiter(page, task());
    const signal = await (waiter as any).readSignal();
    expect(signal).toMatchObject({ active: true, source: "dom", position: 42 });
    expect(passiveQueueSnapshot).toHaveBeenCalledTimes(1);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("treats an explicit passive network release as authoritative on a stable queue URL", async () => {
    const passiveQueueSnapshot = jest.fn(async () => { throw new Error("DOM must not run after release"); });
    const page = { isClosed: () => false, passiveQueueSnapshot, url: () => "https://shop.test/queue/status" } as any;
    const waiter = new BrowserQueueWaiter(page, task());
    await (waiter as any).captureResponse({
      url: () => "https://shop.test/queue/status",
      headers: () => ({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ status: "released" })
    });
    const signal = await (waiter as any).readSignal();
    expect(signal).toMatchObject({ active: false, source: "network", statusText: "released" });
    expect(passiveQueueSnapshot).not.toHaveBeenCalled();
  });

  it("can disable passive network and DOM independently", async () => {
    const on = jest.fn();
    const passiveQueueSnapshot = jest.fn();
    const page = { isClosed: () => false, on, passiveQueueSnapshot, url: () => "https://shop.test/product" } as any;
    const waiter = new BrowserQueueWaiter(page, task(), undefined, { allowPassiveNetwork: false, allowPassiveDom: false });
    waiter.start();
    const signal = await (waiter as any).readSignal();
    expect(on).not.toHaveBeenCalled();
    expect(passiveQueueSnapshot).not.toHaveBeenCalled();
    expect(signal).toMatchObject({ active: false, source: "url" });
  });
});
