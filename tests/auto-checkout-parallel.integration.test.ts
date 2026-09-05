import type { ITaskExecutor } from "../src/interfaces";
import type { CommerceShop } from "../src/commerce/platforms";
import { CommerceTaskExecutorRouter } from "../src/commerce/task-executor-router";
import { MonitorAutoCheckoutCoordinator } from "../src/monitor/auto-checkout-coordinator";
import { CommerceMonitorService, ProductMonitorEventRepository } from "../src/monitor/commerce-monitor-service";
import type { ProductMonitorEvent, ProductObservation } from "../src/monitor/models";
import type { Task } from "../src/models";
import { TaskState } from "../src/models";
import { TaskOrchestrator } from "../src/orchestrator";
import { TaskRepositoryMock, WorkerMock } from "../src/mocks";
import type { CheckoutPaymentSession } from "../src/payments/models";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

const shop: CommerceShop = {
  id: "parallel-shop",
  name: "Parallel Test Shop",
  baseUrl: "http://127.0.0.1",
  platform: "shopify",
  config: {}
};

class MemoryMonitorRepository implements ProductMonitorEventRepository {
  readonly records: Array<{ taskId: string; event: ProductMonitorEvent }> = [];
  async recordProductMonitorEvent(taskId: string, event: ProductMonitorEvent): Promise<void> { this.records.push({ taskId, event }); }
  async findProductMonitorEventsByTaskId(taskId: string, limit = 100): Promise<Array<ProductMonitorEvent & { taskId: string }>> {
    return this.records.filter(record => record.taskId === taskId).slice(-limit).map(record => ({ ...record.event, taskId: record.taskId }));
  }
}

class CheckoutProbeExecutor implements ITaskExecutor {
  readonly executions: Array<{ taskId: string; parentTaskId: string; profileId: string; proxyId: string; sessionId: string; userDataDir: string }> = [];

  async execute(task: Task): Promise<boolean> {
    const data = task.config.data ?? {};
    const trigger = data["triggerSource"] as Record<string, unknown>;
    const proxy = data["proxySelection"] as Record<string, unknown>;
    const sessionId = `session:${task.id}`;
    const userDataDir = `/tmp/ares-test/${task.id}`;
    this.executions.push({
      taskId: task.id,
      parentTaskId: String(trigger?.["parentTaskId"] ?? ""),
      profileId: String(data["profileId"] ?? ""),
      proxyId: String(proxy?.["proxyId"] ?? "direct"),
      sessionId,
      userDataDir
    });
    task.config.data = {
      ...data,
      browserSession: { type: "integration-probe", sessionId, userDataDir, isolatedPerTask: true },
      paymentPreparation: {
        detectedMethods: ["card"], selectedMethod: "card",
        filledFields: ["cardNumber", "expiry", "securityCode"], missingFields: [], requiresUserAction: true,
        note: "Checkout vorbereitet · finaler Bestellbutton bleibt manuell."
      }
    };
    await new Promise(resolve => setTimeout(resolve, 40));
    return true;
  }
}

function observation(available: boolean, price: number): ProductObservation {
  return {
    shopId: shop.id, platform: "shopify", externalId: "pokemon-test-product", sku: "PKM-PARALLEL",
    title: "Pokemon Parallel Test Box", url: "http://127.0.0.1/products/pokemon-parallel-test-box",
    variantId: "variant-1", variantTitle: "Standard", available, stock: available ? 4 : 0,
    price: { amount: price, currency: "EUR" }, observedAt: new Date(), attributes: { source: "controlled-integration-variable" }
  };
}

function createParent(orchestrator: TaskOrchestrator, id: string, profileId: string, proxyId: string): Task {
  return orchestrator.createTask({
    id, name: `Auto Checkout ${id}`, shopId: shop.id, maxRetries: 0,
    data: {
      productCriteria: { searchTerm: "Pokemon Parallel Test Box" }, monitorIntervalMs: 1_000,
      monitorAction: { mode: "auto-checkout", profileId, proxySelection: { mode: "proxy", proxyId }, headless: true, paymentEnabled: true }
    }
  });
}

describeBrowser("parallel monitor → auto checkout integration", () => {
  jest.setTimeout(45_000);

  it("keeps two monitor/checkout chains isolated after a 20 second availability + price change window", async () => {
    let available = false;
    let price = 59.99;
    const monitorRepository = new MemoryMonitorRepository();
    const productApiRouter = { search: jest.fn(async () => [observation(available, price)]) };
    const getShop = (shopId: string) => shopId === shop.id ? shop : undefined;
    let coordinator: MonitorAutoCheckoutCoordinator;

    const monitorService = new CommerceMonitorService(getShop, productApiRouter, monitorRepository, {
      defaultIntervalMs: 1_000,
      minimumIntervalMs: 100,
      onEvent: (taskId, event) => { void coordinator.handleProductEvent(taskId, event); }
    });

    const checkoutProbe = new CheckoutProbeExecutor();
    const router = new CommerceTaskExecutorRouter(getShop);
    router.registerMonitorExecutor(monitorService);
    router.register("shopify", checkoutProbe);

    const orchestrator = new TaskOrchestrator(new TaskRepositoryMock(), router);
    orchestrator.addWorker(new WorkerMock("slot-a"));
    orchestrator.addWorker(new WorkerMock("slot-b"));

    const payments = new Map<string, CheckoutPaymentSession>();
    coordinator = new MonitorAutoCheckoutCoordinator(orchestrator, {
      getPaymentSession: id => payments.get(id),
      setPaymentSession: (id, session) => payments.set(id, session)
    });

    const parentA = createParent(orchestrator, "monitor-A", "profile-A", "proxy-A");
    const parentB = createParent(orchestrator, "monitor-B", "profile-B", "proxy-B");
    payments.set(parentA.id, { method: "card", card: { cardNumber: "4111111111111111", expiry: "12/30", securityCode: "111" } });
    payments.set(parentB.id, { method: "card", card: { cardNumber: "5555555555554444", expiry: "11/31", securityCode: "222" } });

    void orchestrator.startTask(parentA.id);
    void orchestrator.startTask(parentB.id);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(orchestrator.getAllTasks()).toHaveLength(2);
    expect(checkoutProbe.executions).toHaveLength(0);

    available = true;
    price = 44.99;
    await new Promise(resolve => setTimeout(resolve, 20_000));

    const allTasks = orchestrator.getAllTasks();
    const children = allTasks.filter(task => Boolean(task.config.data?.["triggerSource"]));
    expect(children).toHaveLength(2);
    expect(checkoutProbe.executions).toHaveLength(2);
    expect(parentA.state).toBe(TaskState.CANCELLED);
    expect(parentB.state).toBe(TaskState.CANCELLED);
    expect(children.every(child => child.state === TaskState.SUCCESS)).toBe(true);

    const byParent = new Map(checkoutProbe.executions.map(item => [item.parentTaskId, item]));
    const executionA = byParent.get(parentA.id)!;
    const executionB = byParent.get(parentB.id)!;
    expect(executionA.profileId).toBe("profile-A");
    expect(executionA.proxyId).toBe("proxy-A");
    expect(executionB.profileId).toBe("profile-B");
    expect(executionB.proxyId).toBe("proxy-B");
    expect(executionA.taskId).not.toBe(executionB.taskId);
    expect(executionA.sessionId).not.toBe(executionB.sessionId);
    expect(executionA.userDataDir).not.toBe(executionB.userDataDir);

    const changedEvents = monitorRepository.records.filter(record => record.event.current.available);
    expect(changedEvents).toHaveLength(2);
    expect(changedEvents.every(record => record.event.current.price?.amount === 44.99)).toBe(true);
    expect(payments.get(executionA.taskId)?.card?.securityCode).toBe("111");
    expect(payments.get(executionB.taskId)?.card?.securityCode).toBe("222");

    orchestrator.cleanup();
    await router.close();
  });
});
