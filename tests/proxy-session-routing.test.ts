import { BrowserWorkerPoolClient } from "../src/browser-worker/client";
import type { AresProfile } from "../src/profiles/models";
import type { AresProxy } from "../src/proxies/models";
import type { Task } from "../src/models";
import { TaskState } from "../src/models";

const shop = { id: "shop-1", name: "Shop", baseUrl: "https://example.test", platform: "shopify" as const };

const profile: AresProfile = {
  id: "profile-1",
  name: "Shared Profile",
  contact: { firstName: "A", lastName: "B", email: "a@example.test" },
  address: { address1: "Test 1", postalCode: "12345", city: "Test", countryCode: "DE" },
  preferredProxyId: "proxy-default"
};

const proxies = new Map<string, AresProxy>([
  ["proxy-a", { id: "proxy-a", name: "Proxy A", protocol: "http", host: "a.proxy.test", port: 8001, username: "a", password: "one" }],
  ["proxy-b", { id: "proxy-b", name: "Proxy B", protocol: "https", host: "b.proxy.test", port: 8002, username: "b", password: "two" }],
  ["proxy-default", { id: "proxy-default", name: "Default", protocol: "http", host: "default.proxy.test", port: 8003 }]
]);

function task(id: string, proxyId?: string): Task {
  return {
    id,
    config: {
      id,
      name: id,
      shopId: shop.id,
      data: {
        profileId: profile.id,
        proxySelection: proxyId ? { mode: "proxy", proxyId } : { mode: "profile-default" }
      }
    },
    state: TaskState.RUNNING,
    createdAt: new Date(),
    updatedAt: new Date(),
    retries: 0,
    maxRetries: 0
  };
}

describe("BrowserWorkerPoolClient proxy session routing", () => {
  it("resolves a unique proxy per task without mutating the shared stored profile", async () => {
    const captured: Array<{ taskId: string; profile: AresProfile }> = [];
    const pool = new BrowserWorkerPoolClient(
      id => id === shop.id ? shop : undefined,
      id => id === profile.id ? profile : undefined,
      { processCount: 1, getProxy: id => proxies.get(id) }
    );

    const processClient = (pool as any).clients[0];
    processClient.execute = jest.fn(async (resolvedTask: Task, _shop: unknown, effectiveProfile: AresProfile) => {
      captured.push({ taskId: resolvedTask.id, profile: effectiveProfile });
      return true;
    });

    const taskA = task("session-A", "proxy-a");
    const taskB = task("session-B", "proxy-b");
    await Promise.all([pool.execute(taskA), pool.execute(taskB)]);

    expect(captured).toHaveLength(2);
    const a = captured.find(item => item.taskId === taskA.id)!.profile;
    const b = captured.find(item => item.taskId === taskB.id)!.profile;
    expect(a.proxy).toMatchObject({ host: "a.proxy.test", port: 8001, username: "a", password: "one" });
    expect(b.proxy).toMatchObject({ host: "b.proxy.test", port: 8002, username: "b", password: "two" });
    expect(a.proxy?.host).not.toBe(b.proxy?.host);
    expect(profile.proxy).toBeUndefined();
    expect(taskA.config.data?.["proxyRuntime"]).toMatchObject({ proxyId: "proxy-a", proxyName: "Proxy A" });
    expect(taskB.config.data?.["proxyRuntime"]).toMatchObject({ proxyId: "proxy-b", proxyName: "Proxy B" });
  });

  it("uses the profile default proxy and fails closed for a missing explicit proxy", async () => {
    const captured: AresProfile[] = [];
    const pool = new BrowserWorkerPoolClient(
      () => shop,
      () => profile,
      { processCount: 1, getProxy: id => proxies.get(id) }
    );
    const processClient = (pool as any).clients[0];
    processClient.execute = jest.fn(async (_task: Task, _shop: unknown, effectiveProfile: AresProfile) => {
      captured.push(effectiveProfile);
      return true;
    });

    expect(await pool.execute(task("default-session"))).toBe(true);
    expect(captured[0].proxy?.host).toBe("default.proxy.test");

    const missing = task("missing-session", "proxy-does-not-exist");
    expect(await pool.execute(missing)).toBe(false);
    expect(missing.lastError).toContain("nicht mehr vorhanden");
    expect(processClient.execute).toHaveBeenCalledTimes(1);
  });
});
