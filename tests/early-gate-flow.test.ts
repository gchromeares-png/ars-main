import { TaskState, type Task } from "../src/models";
import { TaskOrchestrator } from "../src/orchestrator";
import { TaskRepositoryMock } from "../src/mocks";
import type { ITaskExecutor } from "../src/interfaces";
import { MonitorAutoCheckoutCoordinator } from "../src/monitor/auto-checkout-coordinator";
import { normalizeDiscoveryKeywords } from "../src/monitor/early-gate";

class IdleExecutor implements ITaskExecutor {
  async execute(): Promise<boolean> {
    return true;
  }
}

function createEarlyGateParent(orchestrator: TaskOrchestrator): Task {
  return orchestrator.createTask({
    id: "gate-parent",
    name: "Pokemon Center Drop",
    shopId: "pokemon-center-de",
    data: {
      monitorStrategy: {
        mode: "early-gate",
        productName: "Pokemon Center Elite Trainer Box",
        discoveryKeywords: ["Team Rocket", "Pokemon Center"]
      },
      monitorAction: {
        mode: "auto-checkout",
        profileId: "profile-1",
        proxySelection: { mode: "profile-default" },
        headless: false,
        paymentEnabled: false
      }
    }
  });
}

describe("Early Gate flow", () => {
  it("normalizes multiple live discovery keywords without duplicates", () => {
    expect(normalizeDiscoveryKeywords([
      " Team Rocket ",
      "team   rocket",
      "Pokemon Center",
      "",
      null
    ])).toEqual(["Team Rocket", "Pokemon Center"]);
  });

  it("reuses the existing coordinator and creates exactly one mutually-linked browser child", async () => {
    const orchestrator = new TaskOrchestrator(new TaskRepositoryMock(), new IdleExecutor());
    const parent = createEarlyGateParent(orchestrator);
    const coordinator = new MonitorAutoCheckoutCoordinator(orchestrator);
    const event = {
      type: "queue-signal" as const,
      shopId: "pokemon-center-de",
      observedAt: new Date("2026-09-04T08:00:00.000Z"),
      source: "incapsula-resource",
      position: 314,
      timeToWaitSeconds: 120
    };

    const child = await coordinator.handleGateEvent(parent.id, event);
    expect(child).toBeDefined();
    expect(parent.state).toBe(TaskState.CANCELLED);

    const parentRuntime = parent.config.data?.["earlyGateRuntime"] as Record<string, unknown>;
    const childRuntime = child!.config.data?.["earlyGateRuntime"] as Record<string, unknown>;
    const trigger = child!.config.data?.["triggerSource"] as Record<string, unknown>;

    expect(parentRuntime["childTaskId"]).toBe(child!.id);
    expect(childRuntime["parentTaskId"]).toBe(parent.id);
    expect(trigger).toMatchObject({
      kind: "early-gate",
      parentTaskId: parent.id,
      gateType: "queue-signal",
      gateSource: "incapsula-resource"
    });
    expect(child!.config.data?.["postQueueDiscovery"]).toMatchObject({
      productName: "Pokemon Center Elite Trainer Box",
      keywords: ["Team Rocket", "Pokemon Center"]
    });

    const secondChild = await coordinator.handleGateEvent(parent.id, event);
    expect(secondChild).toBeUndefined();
    expect(orchestrator.getAllTasks().filter(task => task.id.includes("__gate_")).length).toBe(1);
    orchestrator.cleanup();
  });

  it("moves only an Early-Gate child from a released queue edge into POST_QUEUE_DISCOVERY", () => {
    const orchestrator = new TaskOrchestrator(new TaskRepositoryMock(), new IdleExecutor());
    const early = orchestrator.createTask({
      id: "gate-child",
      name: "Gate Child",
      shopId: "pokemon-center-de",
      data: {
        triggerSource: { kind: "early-gate", parentTaskId: "gate-parent" },
        postQueueDiscovery: { productName: "Pokemon", keywords: ["ETB"] }
      }
    });
    early.state = TaskState.RUNNING;
    early.config.data = {
      ...(early.config.data ?? {}),
      queueStatus: {
        active: true,
        phase: "waiting",
        detectedAt: "2026-09-04T08:00:00.000Z",
        updatedAt: "2026-09-04T08:00:01.000Z",
        elapsedMs: 1000,
        maxWaitMs: 60 * 60_000,
        source: "network",
        position: 55,
        timeToWaitSeconds: 90
      }
    };

    orchestrator.setTaskQueueWaiting(early.id, true);
    expect(early.state).toBe(TaskState.WAITING_QUEUE);

    early.config.data = {
      ...(early.config.data ?? {}),
      queueStatus: {
        ...((early.config.data?.["queueStatus"] as Record<string, unknown>) ?? {}),
        active: false,
        phase: "released",
        updatedAt: "2026-09-04T08:01:00.000Z",
        releasedAt: "2026-09-04T08:01:00.000Z",
        timeToWaitSeconds: 0
      }
    };
    orchestrator.setTaskQueueWaiting(early.id, false);
    expect(early.state).toBe(TaskState.POST_QUEUE_DISCOVERY);

    const runtime = early.config.data?.["earlyGateRuntime"] as Record<string, unknown>;
    expect(runtime["queueReleasedAt"]).toBe("2026-09-04T08:01:00.000Z");
    expect(runtime["stage"]).toBe("post-queue-discovery");

    const normal = orchestrator.createTask({ id: "normal-child", name: "Normal", shopId: "shopify" });
    normal.state = TaskState.RUNNING;
    normal.config.data = {
      queueStatus: {
        active: true,
        phase: "waiting",
        detectedAt: "2026-09-04T08:00:00.000Z",
        updatedAt: "2026-09-04T08:00:00.000Z",
        elapsedMs: 0,
        maxWaitMs: 60 * 60_000,
        source: "dom"
      }
    };
    orchestrator.setTaskQueueWaiting(normal.id, true);
    expect(normal.state).toBe(TaskState.WAITING_QUEUE);
    normal.config.data = {
      queueStatus: {
        ...((normal.config.data?.["queueStatus"] as Record<string, unknown>) ?? {}),
        active: false,
        phase: "released",
        releasedAt: "2026-09-04T08:01:00.000Z"
      }
    };
    orchestrator.setTaskQueueWaiting(normal.id, false);
    expect(normal.state).toBe(TaskState.RUNNING);
    orchestrator.cleanup();
  });
});
