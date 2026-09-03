import { mkdtemp, rm } from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { CommerceShop } from "../src/commerce/platforms";
import { CommerceMonitorService } from "../src/monitor/commerce-monitor-service";
import type { ProductObservation } from "../src/monitor/models";
import { SqliteTaskStore } from "../src/persistence/sqlite-task-store";
import { Task, TaskState } from "../src/models";

function observation(overrides: Partial<ProductObservation> = {}): ProductObservation {
  return {
    shopId: "shop-1",
    platform: "shopify",
    externalId: "product-1",
    sku: "PKM-1",
    title: "Pokemon Gengar Collection",
    url: "https://example.test/products/gengar",
    variantId: "v1",
    variantTitle: "Standard",
    available: true,
    stock: 3,
    price: { amount: 39.99, currency: "EUR" },
    observedAt: new Date("2026-09-03T08:00:00Z"),
    ...overrides
  };
}

function task(): Task {
  return {
    id: "task-monitor-1",
    config: {
      id: "task-monitor-1",
      name: "Pokemon Monitor",
      shopId: "shop-1",
      data: {
        productCriteria: { searchTerm: "Pokemon Gengar" },
        monitorIntervalMs: 5
      }
    },
    state: TaskState.RUNNING,
    createdAt: new Date("2026-09-03T08:00:00Z"),
    updatedAt: new Date("2026-09-03T08:00:00Z"),
    retries: 0,
    maxRetries: 2
  };
}

const shop: CommerceShop = {
  id: "shop-1",
  name: "Shop 1",
  baseUrl: "https://example.test",
  platform: "shopify",
  config: {}
};

describe("CommerceMonitorService", () => {
  let directory: string;
  let databasePath: string;
  let store: SqliteTaskStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "ares-monitor-"));
    databasePath = path.join(directory, "ares.sqlite");
    store = await SqliteTaskStore.open(databasePath);
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("persists first-seen and real changes but not unchanged observations", async () => {
    let current = observation();
    const router = {
      search: jest.fn(async () => [current])
    };

    const service = new CommerceMonitorService(
      id => id === shop.id ? shop : undefined,
      router,
      store,
      { minimumIntervalMs: 1 }
    );
    const monitorTask = task();

    expect((await service.runCycle(monitorTask)).map(event => event.type)).toEqual(["first-seen"]);
    expect(await service.runCycle(monitorTask)).toEqual([]);

    current = observation({ stock: 7, observedAt: new Date("2026-09-03T08:01:00Z") });
    expect((await service.runCycle(monitorTask)).map(event => event.type)).toEqual(["stock-increased"]);

    current = observation({ stock: 7, available: false, observedAt: new Date("2026-09-03T08:02:00Z") });
    expect((await service.runCycle(monitorTask)).map(event => event.type)).toEqual(["availability-changed"]);

    current = observation({
      stock: 7,
      available: false,
      price: { amount: 34.99, currency: "EUR" },
      observedAt: new Date("2026-09-03T08:03:00Z")
    });
    expect((await service.runCycle(monitorTask)).map(event => event.type)).toEqual(["price-changed"]);

    const events = await store.findProductMonitorEventsByTaskId(monitorTask.id);
    expect(events.map(event => event.type)).toEqual([
      "first-seen",
      "stock-increased",
      "availability-changed",
      "price-changed"
    ]);

    const logs = await store.findLogsByTaskId(monitorTask.id);
    expect(logs.map(log => log.event)).toEqual([
      "product:first-seen",
      "product:stock-increased",
      "product:availability-changed",
      "product:price-changed"
    ]);

    await service.close();
  });

  it("restores monitor history after reopening SQLite", async () => {
    const router = { search: jest.fn(async () => [observation()]) };
    const service = new CommerceMonitorService(() => shop, router, store);
    const monitorTask = task();

    await service.runCycle(monitorTask);
    await service.close();
    await store.close();

    store = await SqliteTaskStore.open(databasePath);
    const restored = await store.findProductMonitorEventsByTaskId(monitorTask.id);

    expect(restored).toHaveLength(1);
    expect(restored[0].type).toBe("first-seen");
    expect(restored[0].current.title).toBe("Pokemon Gengar Collection");
    expect(restored[0].observedAt).toBeInstanceOf(Date);
  });

  it("stops a running monitor loop when cancelled", async () => {
    const router = { search: jest.fn(async () => [observation()]) };
    const service = new CommerceMonitorService(
      () => shop,
      router,
      store,
      { defaultIntervalMs: 5, minimumIntervalMs: 1 }
    );
    const monitorTask = task();

    const execution = service.execute(monitorTask);
    await new Promise(resolve => setTimeout(resolve, 15));
    await service.cancelTask(monitorTask.id);

    await expect(execution).resolves.toBe(true);
    const callsAfterCancel = router.search.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(router.search.mock.calls.length).toBe(callsAfterCancel);
  });

  it("isolates a failing shop from a healthy task", async () => {
    const router = {
      search: jest.fn(async (resolvedShop: CommerceShop) => {
        if (resolvedShop.id === "broken") throw new Error("shop failed");
        return [observation({ shopId: resolvedShop.id })];
      })
    };
    const healthyShop = { ...shop, id: "healthy" };
    const brokenShop = { ...shop, id: "broken" };
    const shops = new Map([[healthyShop.id, healthyShop], [brokenShop.id, brokenShop]]);
    const service = new CommerceMonitorService(id => shops.get(id), router, store);

    const healthy = task();
    healthy.id = "healthy-task";
    healthy.config.id = healthy.id;
    healthy.config.shopId = healthyShop.id;

    const broken = task();
    broken.id = "broken-task";
    broken.config.id = broken.id;
    broken.config.shopId = brokenShop.id;

    await expect(service.runCycle(broken)).rejects.toThrow("shop failed");
    await expect(service.runCycle(healthy)).resolves.toHaveLength(1);
  });
});
