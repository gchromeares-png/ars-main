import { CommerceTaskExecutorRouter } from "../src/commerce/task-executor-router";
import type { CommerceShop } from "../src/commerce/platforms";
import type { ITaskExecutor } from "../src/interfaces";
import { TaskState, type Task } from "../src/models";

class DeferredGateExecutor implements ITaskExecutor {
  readonly executed: string[] = [];
  readonly keywordUpdates: Array<{ taskId: string; keywords: string[] }> = [];
  readonly purchaseUpdates: boolean[] = [];
  private resolveRun?: (value: boolean) => void;

  async execute(task: Task): Promise<boolean> {
    this.executed.push(task.id);
    return new Promise<boolean>(resolve => { this.resolveRun = resolve; });
  }

  async updateDiscoveryKeywords(taskId: string, keywords: string[]): Promise<string[]> {
    this.keywordUpdates.push({ taskId, keywords: [...keywords] });
    return keywords.map(value => value.trim()).filter(Boolean);
  }

  async setFinalPurchaseAllowed(allowed: boolean): Promise<void> {
    this.purchaseUpdates.push(allowed);
  }

  finish(value = true): void {
    this.resolveRun?.(value);
  }
}

function earlyGateChild(): Task {
  const now = new Date();
  return {
    id: "gate-child",
    config: {
      id: "gate-child",
      name: "Pokemon Center Release",
      shopId: "pokemon-center-de",
      data: {
        triggerSource: { kind: "early-gate", parentTaskId: "gate-parent" },
        profileId: "profile-1",
        postQueueDiscovery: { productName: "Pokemon ETB", keywords: ["ETB"] }
      }
    },
    state: TaskState.POST_QUEUE_DISCOVERY,
    createdAt: now,
    updatedAt: now,
    retries: 0,
    maxRetries: 0
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CommerceTaskExecutorRouter Early Gate path", () => {
  it("routes a non-Shopify Early-Gate child through the dedicated executor and forwards live controls", async () => {
    const shop: CommerceShop = {
      id: "pokemon-center-de",
      name: "Pokemon Center DE",
      baseUrl: "https://www.pokemoncenter.com/de-de",
      platform: "custom",
      config: {}
    };
    const gate = new DeferredGateExecutor();
    const router = new CommerceTaskExecutorRouter(id => id === shop.id ? shop : undefined);
    router.registerEarlyGateExecutor(gate);
    const task = earlyGateChild();

    const run = router.execute(task);
    await settle();
    expect(gate.executed).toEqual([task.id]);

    const keywords = await router.updateDiscoveryKeywords(task.id, [" Team Rocket ", "ETB"]);
    expect(keywords).toEqual(["Team Rocket", "ETB"]);
    expect(gate.keywordUpdates).toEqual([{ taskId: task.id, keywords: [" Team Rocket ", "ETB"] }]);

    await router.setFinalPurchaseAllowed(true);
    await router.setFinalPurchaseAllowed(false);
    expect(gate.purchaseUpdates).toEqual([true, false]);

    gate.finish(true);
    await expect(run).resolves.toBe(true);
    await router.close();
  });
});
