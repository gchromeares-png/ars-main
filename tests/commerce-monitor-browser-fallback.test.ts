import type { CommerceShop } from "../src/commerce/platforms";
import type { Task } from "../src/models";
import { TaskState } from "../src/models";
import { CommerceMonitorService } from "../src/monitor/commerce-monitor-service";
import type { BrowserProductFallback } from "../src/monitor/browser-product-fallback";
import type { ProductObservation } from "../src/monitor/models";

const shop: CommerceShop = {
  id: "dynamic-shop",
  name: "Dynamic Shop",
  baseUrl: "https://dynamic.invalid/",
  platform: "custom",
  config: {}
};

function task(id: string): Task {
  const now = new Date();
  return {
    id,
    config: {
      id,
      name: id,
      shopId: shop.id,
      data: {
        productCriteria: { searchTerm: "Stellar Booster" },
        monitorAction: { mode: "monitor-only", headless: true }
      }
    },
    state: TaskState.RUNNING,
    createdAt: now,
    updatedAt: now,
    retries: 0,
    maxRetries: 0
  };
}

function observation(available: boolean, signal: string, source = "generic-html"): ProductObservation {
  return {
    shopId: shop.id,
    platform: shop.platform,
    externalId: "https://dynamic.invalid/product",
    title: "Stellar Booster",
    url: "https://dynamic.invalid/product",
    available,
    attributes: {
      source,
      availabilitySignal: signal
    },
    observedAt: new Date()
  };
}

describe("CommerceMonitorService browser fallback", () => {
  it("uses rendered browser observations when HTTP HTML matched but availability stayed unknown", async () => {
    const fallbackSearch = jest.fn(async () => [observation(true, "schema-in-stock", "seleniumbase-rendered-html")]);
    const fallback: BrowserProductFallback = {
      search: fallbackSearch,
      cancelTask: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined)
    };
    const recorded: any[] = [];
    const service = new CommerceMonitorService(
      id => id === shop.id ? shop : undefined,
      { search: async () => [observation(false, "unknown")] },
      {
        recordProductMonitorEvent: async (_taskId, event) => { recorded.push(event); },
        findProductMonitorEventsByTaskId: async () => []
      },
      { browserFallback: fallback }
    );

    const events = await service.runCycle(task("browser-fallback"), shop, { searchTerm: "Stellar Booster" });

    expect(fallbackSearch).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].current.available).toBe(true);
    expect(events[0].current.attributes?.["source"]).toBe("seleniumbase-rendered-html");
    expect(recorded).toHaveLength(1);
    await service.close();
  });

  it("does not waste Chromium when HTTP already has an explicit sold-out signal", async () => {
    const fallbackSearch = jest.fn(async () => [observation(true, "schema-in-stock", "seleniumbase-rendered-html")]);
    const fallback: BrowserProductFallback = {
      search: fallbackSearch,
      cancelTask: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined)
    };
    const service = new CommerceMonitorService(
      id => id === shop.id ? shop : undefined,
      { search: async () => [observation(false, "negative:sold out")] },
      {
        recordProductMonitorEvent: async () => undefined,
        findProductMonitorEventsByTaskId: async () => []
      },
      { browserFallback: fallback }
    );

    const events = await service.runCycle(task("http-enough"), shop, { searchTerm: "Stellar Booster" });

    expect(fallbackSearch).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].current.available).toBe(false);
    await service.close();
  });
});
