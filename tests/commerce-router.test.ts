import { CommerceTaskExecutorRouter } from "../src/commerce/task-executor-router";
import type { CommerceShop } from "../src/commerce/platforms";
import type { ITaskExecutor } from "../src/interfaces";
import { Task, TaskState } from "../src/models";

class RecordingExecutor implements ITaskExecutor {
  readonly executed: string[] = [];
  readonly cancelled: string[] = [];

  async execute(task: Task): Promise<boolean> {
    this.executed.push(task.id);
    return true;
  }

  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.push(taskId);
  }
}

function task(id: string, shopId: string): Task {
  const now = new Date();
  return {
    id,
    config: { id, name: id, shopId },
    state: TaskState.QUEUED,
    createdAt: now,
    updatedAt: now,
    retries: 0,
    maxRetries: 3
  };
}

describe("CommerceTaskExecutorRouter", () => {
  it("routes each platform only to its registered executor", async () => {
    const shops = new Map<string, CommerceShop>([
      ["shopify-shop", { id: "shopify-shop", name: "A", baseUrl: "https://a.test", platform: "shopify", config: {} }],
      ["woo-shop", { id: "woo-shop", name: "B", baseUrl: "https://b.test", platform: "woocommerce", config: {} }]
    ]);
    const shopify = new RecordingExecutor();
    const woo = new RecordingExecutor();
    const router = new CommerceTaskExecutorRouter(id => shops.get(id));
    router.register("shopify", shopify);
    router.register("woocommerce", woo);

    expect(await router.execute(task("t1", "shopify-shop"))).toBe(true);
    expect(await router.execute(task("t2", "woo-shop"))).toBe(true);
    expect(shopify.executed).toEqual(["t1"]);
    expect(woo.executed).toEqual(["t2"]);
  });

  it("fails clearly when a platform is registered as a shop but has no executor yet", async () => {
    const shop: CommerceShop = {
      id: "wix-shop",
      name: "Wix",
      baseUrl: "https://wix.test",
      platform: "wix",
      config: {}
    };
    const router = new CommerceTaskExecutorRouter(id => id === shop.id ? shop : undefined);
    router.register("shopify", new RecordingExecutor());
    const currentTask = task("wix-task", shop.id);

    expect(await router.execute(currentTask)).toBe(false);
    expect(currentTask.lastError).toContain("wix");
    expect(currentTask.lastError).toContain("noch kein Task-Executor");
  });
});
