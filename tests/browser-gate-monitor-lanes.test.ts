import * as fs from "fs";
import * as path from "path";
import { CommerceTaskExecutorRouter } from "../src/commerce/task-executor-router";
import type { ITaskExecutor } from "../src/interfaces";
import type { Task } from "../src/models";
import { resolveMonitorNetworkMode } from "../src/monitor/browser-gate-monitor-executor";

class CaptureExecutor implements ITaskExecutor {
  task?: Task;
  async execute(task: Task): Promise<boolean> { this.task = task; return true; }
}

function gateTask(): Task {
  const now = new Date();
  return {
    id: "gate-lane-1",
    state: "QUEUED" as any,
    retries: 0,
    maxRetries: 3,
    createdAt: now,
    updatedAt: now,
    config: {
      id: "gate-lane-1",
      name: "Gate Lane",
      shopId: "shop-1",
      data: {
        monitorStrategy: { mode: "early-gate", productName: "Exam Product", discoveryKeywords: ["exam", "product"] },
        monitorAction: {
          mode: "auto-checkout",
          profileId: "profile-1",
          proxySelection: { mode: "proxy", proxyId: "proxy-1" },
          headless: true
        }
      }
    }
  };
}

describe("browser gate monitor lanes", () => {
  it("routes early-gate monitoring to the browser executor with one profile/proxy lane", async () => {
    const executor = new CaptureExecutor();
    const router = new CommerceTaskExecutorRouter(id => id === "shop-1" ? ({ id, name: "Shop", baseUrl: "https://example.test", platform: "custom", config: {} } as any) : undefined);
    router.registerEarlyGateExecutor(executor);
    const task = gateTask();
    expect(await router.execute(task)).toBe(true);
    expect(executor.task?.config.data?.["profileId"]).toBe("profile-1");
    expect(executor.task?.config.data?.["proxySelection"]).toEqual({ mode: "proxy", proxyId: "proxy-1" });
    expect(executor.task?.config.data?.["postQueueDiscovery"]).toEqual({ productName: "Exam Product", keywords: ["exam", "product"] });
    expect(executor.task?.config.data?.["earlyGateLane"]).toMatchObject({ mode: "browser-monitor", monitorOnlyUntilRelease: true, proxyBound: true });
  });

  it("keeps monitor mode lightweight and hands off to the separate completion executor", () => {
    const monitor = fs.readFileSync(path.join(process.cwd(), "src/monitor/browser-gate-monitor-executor.ts"), "utf8");
    const worker = fs.readFileSync(path.join(process.cwd(), "src/browser-worker/worker.ts"), "utf8");
    const runtime = fs.readFileSync(path.join(process.cwd(), "src/browser-worker/seleniumbase-browser-worker.ts"), "utf8");
    expect(monitor).toContain("monitorMode: true");
    expect(monitor).not.toContain("SemanticCheckoutPreparer");
    expect(monitor).not.toContain("CheckoutPaymentPreparer");
    expect(worker).toContain("await browserGateMonitorExecutor.execute(request.task)");
    expect(worker).toContain("await earlyGateExecutor.execute(request.task, paymentSession)");
    expect(runtime).toContain('ARES_SB_MONITOR_MODE: config.monitorMode === true ? "1" : "0"');
  });

  it("uses the profile user-agent for the monitor lane", () => {
    const monitor = fs.readFileSync(path.join(process.cwd(), "src/monitor/browser-gate-monitor-executor.ts"), "utf8");
    expect(monitor).toContain("userAgent: profile.browser?.userAgent?.trim() || undefined");
  });

  it("defaults to normal session-http monitoring", () => {
    const task = gateTask();
    const shop = { id: "shop-1", name: "Shop", baseUrl: "https://example.test", platform: "custom", config: {} } as any;
    expect(resolveMonitorNetworkMode(task, shop)).toBe("session-http-preferred");
  });

  it("allows strict browser-only monitoring per task", () => {
    const task = gateTask();
    task.config.data = { ...(task.config.data ?? {}), monitorNetworkMode: "browser-only" };
    const shop = { id: "shop-1", name: "Shop", baseUrl: "https://example.test", platform: "custom", config: {} } as any;
    expect(resolveMonitorNetworkMode(task, shop)).toBe("browser-only");
  });

  it("allows strict browser-only monitoring per shop and task override wins", () => {
    const task = gateTask();
    const shop = {
      id: "shop-1",
      name: "Shop",
      baseUrl: "https://example.test",
      platform: "custom",
      config: { monitorNetworkMode: "browser-only" }
    } as any;
    expect(resolveMonitorNetworkMode(task, shop)).toBe("browser-only");

    task.config.data = { ...(task.config.data ?? {}), monitorNetworkMode: "session-http-preferred" };
    expect(resolveMonitorNetworkMode(task, shop)).toBe("session-http-preferred");
  });

  it("does not instantiate session HTTP in strict mode", () => {
    const monitor = fs.readFileSync(path.join(process.cwd(), "src/monitor/browser-gate-monitor-executor.ts"), "utf8");
    expect(monitor).toContain('if (networkMode === "session-http-preferred")');
    expect(monitor).toContain('stage=session-http skipped=true reason=browser-only');
    expect(monitor).toContain('externalSignal: networkMode === "session-http-preferred"');
  });
});
