import type { CommerceShop } from "../src/commerce/platforms";
import { CommerceTaskExecutorRouter } from "../src/commerce/task-executor-router";
import {
  CommerceMonitorService,
  ProductMonitorEventRepository
} from "../src/monitor/commerce-monitor-service";
import type { ProductMonitorEvent, ProductObservation } from "../src/monitor/models";
import { TaskState } from "../src/models";
import { TaskOrchestrator } from "../src/orchestrator";
import { TaskRepositoryMock, WorkerMock } from "../src/mocks";

const shop: CommerceShop = {
  id: "shop-1",
  name: "Shop 1",
  baseUrl: "https://example.test",
  platform: "shopify",
  config: {}
};

function observation(overrides: Partial<ProductObservation> = {}): ProductObservation {
  return {
    shopId: shop.id,
    platform: shop.platform,
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

class MemoryMonitorRepository implements ProductMonitorEventRepository {
  readonly records: Array<{ taskId: string; event: ProductMonitorEvent }> = [];

  async recordProductMonitorEvent(taskId: string, event: ProductMonitorEvent): Promise<void> {
    this.records.push({ taskId, event });
  }

  async findProductMonitorEventsByTaskId(
    taskId: string,
    limit = 100
  ): Promise<Array<ProductMonitorEvent & { id?: number; taskId: string }>> {
    return this.records
      .filter(record => record.taskId === taskId)
      .slice(-limit)
      .map((record, index) => ({
        ...record.event,
        id: index + 1,
        taskId: record.taskId
      }));
  }
}

async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await Promise.resolve();
  }
}

function buildHarness(
  search: (resolvedShop: CommerceShop) => Promise<ProductObservation[]>,
  taskId = "monitor-lifecycle"
) {
  const repository = new MemoryMonitorRepository();
  const productApiRouter = { search: jest.fn(search) };
  const getShop = (shopId: string) => shopId === shop.id ? shop : undefined;
  const monitorService = new CommerceMonitorService(
    getShop,
    productApiRouter,
    repository,
    { defaultIntervalMs: 1_000, minimumIntervalMs: 1 }
  );
  const commerceRouter = new CommerceTaskExecutorRouter(getShop);
  commerceRouter.registerMonitorExecutor(monitorService);

  const orchestrator = new TaskOrchestrator(new TaskRepositoryMock(), commerceRouter);
  orchestrator.addWorker(new WorkerMock("monitor-worker-1"));
  orchestrator.on("taskCancelled", task => monitorService.resetTask(task.id));

  const task = orchestrator.createTask({
    id: taskId,
    name: "Pokemon Monitor",
    shopId: shop.id,
    maxRetries: 2,
    data: {
      productCriteria: { searchTerm: "Pokemon Gengar" },
      monitorIntervalMs: 1_000
    }
  });

  return {
    task,
    repository,
    productApiRouter,
    monitorService,
    commerceRouter,
    orchestrator
  };
}

describe("Commerce monitoring orchestrator lifecycle", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps monitor state across pause/resume, retries a transient failure, then cancels cleanly", async () => {
    let call = 0;
    const harness = buildHarness(async () => {
      call += 1;
      if (call === 3) throw new Error("transient monitor failure");
      return [observation({ observedAt: new Date(`2026-09-03T08:00:0${Math.min(call, 9)}Z`) })];
    });

    const firstRun = harness.orchestrator.startTask(harness.task.id);
    await settle();

    expect(harness.task.state).toBe(TaskState.RUNNING);
    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(1);
    expect(harness.repository.records.map(record => record.event.type)).toEqual(["first-seen"]);

    await harness.orchestrator.pauseTask(harness.task.id);
    await firstRun;
    expect(harness.task.state).toBe(TaskState.PAUSED);

    jest.advanceTimersByTime(10_000);
    await settle();
    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(1);

    await harness.orchestrator.resumeTask(harness.task.id);
    await settle();

    expect(harness.task.state).toBe(TaskState.RUNNING);
    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(2);
    expect(harness.repository.records.map(record => record.event.type)).toEqual(["first-seen"]);

    jest.advanceTimersByTime(1_000);
    await settle();

    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(3);
    expect(harness.task.state).toBe(TaskState.RETRYING);
    expect(harness.task.retries).toBe(1);
    expect(harness.task.lastError).toContain("transient monitor failure");

    jest.advanceTimersByTime(4_999);
    await settle();
    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(3);
    expect(harness.task.state).toBe(TaskState.RETRYING);

    jest.advanceTimersByTime(1);
    await settle();

    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(4);
    expect(harness.task.state).toBe(TaskState.RUNNING);
    expect(harness.task.retries).toBe(1);
    expect(harness.task.lastError).toBeUndefined();
    expect(harness.repository.records.map(record => record.event.type)).toEqual(["first-seen"]);

    harness.orchestrator.cancelTask(harness.task.id);
    await settle();
    expect(harness.task.state).toBe(TaskState.CANCELLED);

    const callsAfterCancel = harness.productApiRouter.search.mock.calls.length;
    jest.advanceTimersByTime(10_000);
    await settle();
    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(callsAfterCancel);

    harness.orchestrator.cleanup();
    await harness.commerceRouter.close();
  });

  it("cancels a scheduled retry while paused and resumes with exactly one fresh monitor run", async () => {
    let call = 0;
    const harness = buildHarness(async () => {
      call += 1;
      if (call === 1) throw new Error("temporary shop error");
      return [observation({ observedAt: new Date("2026-09-03T08:01:00Z") })];
    }, "monitor-retry-pause");

    await harness.orchestrator.startTask(harness.task.id);
    await settle();

    expect(harness.task.state).toBe(TaskState.RETRYING);
    expect(harness.task.retries).toBe(1);
    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(1);

    await harness.orchestrator.pauseTask(harness.task.id);
    expect(harness.task.state).toBe(TaskState.PAUSED);

    jest.advanceTimersByTime(10_000);
    await settle();
    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(1);
    expect(harness.task.state).toBe(TaskState.PAUSED);

    await harness.orchestrator.resumeTask(harness.task.id);
    await settle();

    expect(harness.productApiRouter.search).toHaveBeenCalledTimes(2);
    expect(harness.task.state).toBe(TaskState.RUNNING);
    expect(harness.task.lastError).toBeUndefined();
    expect(harness.repository.records.map(record => record.event.type)).toEqual(["first-seen"]);

    harness.orchestrator.cancelTask(harness.task.id);
    await settle();
    expect(harness.task.state).toBe(TaskState.CANCELLED);

    harness.orchestrator.cleanup();
    await harness.commerceRouter.close();
  });
});
