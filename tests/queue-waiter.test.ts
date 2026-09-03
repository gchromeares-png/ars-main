import { ShopifyQueueWaiter } from "../src/shopify/queue-waiter";
import type { Task } from "../src/models";

interface DomSignal {
  hasQueuePosition: boolean;
  hasPosition: boolean;
  positionText: string;
  statusText: string;
  url: string;
}

class FakeQueuePage {
  private index = 0;
  private responseListener?: (response: any) => void;

  constructor(private readonly signals: DomSignal[]) {}

  isClosed(): boolean {
    return false;
  }

  url(): string {
    return this.signals[Math.min(this.index, this.signals.length - 1)]?.url ?? "https://shop.test/";
  }

  on(event: string, listener: (response: any) => void): void {
    if (event === "response") this.responseListener = listener;
  }

  off(event: string, listener: (response: any) => void): void {
    if (event === "response" && this.responseListener === listener) this.responseListener = undefined;
  }

  async evaluate(): Promise<DomSignal> {
    const signal = this.signals[Math.min(this.index, this.signals.length - 1)];
    this.index += 1;
    return signal;
  }

  emitJsonResponse(payload: unknown, url = "https://shop.test/Incapsula_Resource?queue=1"): void {
    this.responseListener?.({
      url: () => url,
      headers: () => ({ "content-type": "application/json" }),
      text: async () => JSON.stringify(payload)
    });
  }
}

function task(): Task {
  const now = new Date();
  return {
    id: "queue-test",
    config: { id: "queue-test", name: "Queue Test", data: {} },
    state: "RUNNING" as any,
    createdAt: now,
    updatedAt: now,
    retries: 0,
    maxRetries: 0
  };
}

const queued: DomSignal = {
  hasQueuePosition: true,
  hasPosition: true,
  positionText: "14205",
  statusText: "Waiting in queue",
  url: "https://shop.test/queue"
};

const clear: DomSignal = {
  hasQueuePosition: false,
  hasPosition: false,
  positionText: "",
  statusText: "",
  url: "https://shop.test/checkout"
};

describe("ShopifyQueueWaiter", () => {
  it("publishes queue position and waits for two clear confirmations before release", async () => {
    const page = new FakeQueuePage([queued, queued, clear, clear]);
    const currentTask = task();
    const updates: any[] = [];
    const waiter = new ShopifyQueueWaiter(
      page as any,
      currentTask,
      updated => updates.push(JSON.parse(JSON.stringify(updated.config.data?.["queueStatus"]))),
      { pollIntervalMs: 250, maxWaitMs: 5_000, releaseConfirmations: 2 }
    );

    waiter.start();
    try {
      const result = await waiter.waitIfQueued();
      expect(result.detected).toBe(true);
      expect(result.released).toBe(true);
      expect(updates.some(update => update?.active === true && update?.position === 14205)).toBe(true);
      expect(updates[updates.length - 1]).toMatchObject({
        active: false,
        phase: "released",
        position: 14205,
        timeToWaitSeconds: 0
      });
    } finally {
      waiter.stop();
    }
  });

  it("captures pos and ttw from matching queue network responses", async () => {
    const page = new FakeQueuePage([clear]);
    const currentTask = task();
    const waiter = new ShopifyQueueWaiter(page as any, currentTask);

    waiter.start();
    try {
      page.emitJsonResponse({ pos: 812, ttw: 33, status: "waiting" });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect((waiter as any).networkSignal).toMatchObject({
        position: 812,
        timeToWaitSeconds: 33,
        statusText: "waiting"
      });
    } finally {
      waiter.stop();
    }
  });

  it("does not treat a normal page as a queue", async () => {
    const page = new FakeQueuePage([clear]);
    const waiter = new ShopifyQueueWaiter(page as any, task());
    const result = await waiter.waitIfQueued();

    expect(result).toEqual({ detected: false, released: false, elapsedMs: 0 });
  });
});
