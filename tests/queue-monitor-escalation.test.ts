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
    const evaluate = jest.fn(async () => { throw new Error("DOM must not run"); });
    const page = { isClosed: () => false, evaluate, url: () => "https://shop.test/" } as any;
    const waiter = new BrowserQueueWaiter(page, task(), undefined, {
      externalSignal: () => ({ active: true, position: 17, timeToWaitSeconds: 9, source: "session-http" })
    });
    const signal = await (waiter as any).readSignal();
    expect(signal).toMatchObject({ active: true, source: "session-http", position: 17, timeToWaitSeconds: 9 });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("falls back to passive DOM inspection when lightweight/network signals are absent", async () => {
    const passiveEvaluate = jest.fn(async () => ({
      hasQueuePosition: true,
      hasPosition: true,
      positionText: "42",
      statusText: "Waiting in queue",
      url: "https://shop.test/"
    }));
    const evaluate = jest.fn(async () => { throw new Error("active evaluate must not be preferred"); });
    const page = { isClosed: () => false, passiveEvaluate, evaluate, url: () => "https://shop.test/" } as any;
    const waiter = new BrowserQueueWaiter(page, task());
    const signal = await (waiter as any).readSignal();
    expect(signal).toMatchObject({ active: true, source: "dom", position: 42 });
    expect(passiveEvaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
