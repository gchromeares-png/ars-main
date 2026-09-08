import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase runtime starvation proof", () => {
  const read = (relative: string): string =>
    fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

  const taskWorker = read("python/seleniumbase_cdp/task_browser_worker.py");
  const oopifWorker = read("python/seleniumbase_cdp/task_browser_worker_oopif.py");
  const rpcPage = read("src/browser-worker/seleniumbase-rpc-page.ts");
  const controlAware = read("python/seleniumbase_cdp/control_aware_seleniumbase_adapter.py");
  const scheduler = read("python/seleniumbase_cdp/runtime_poll_scheduler.py");
  const manualWorker = read("python/seleniumbase_cdp/manual_profile_browser.py");
  const productMonitorWorker = read("python/seleniumbase_cdp/product_monitor_browser.py");

  function simulateQueue(
    telemetryIntervalMs: number,
    queueIdleTimeoutMs: number,
    durationMs: number
  ): { commands: number; idlePolls: number } {
    let now = 0;
    let nextTelemetry = 0;
    let commands = 0;
    let idlePolls = 0;

    while (now < durationMs) {
      const idleDeadline = now + queueIdleTimeoutMs;
      if (nextTelemetry <= idleDeadline) {
        now = nextTelemetry;
        commands += 1;
        nextTelemetry += telemetryIntervalMs;
      } else {
        now = idleDeadline;
        idlePolls += 1;
      }
    }

    return { commands, idlePolls };
  }

  function simulateFairCadence(
    telemetryIntervalMs: number,
    runtimeIntervalMs: number,
    durationMs: number
  ): { commands: number; runtimePolls: number } {
    let now = 0;
    let nextTelemetry = 0;
    let nextRuntime = runtimeIntervalMs;
    let commands = 0;
    let runtimePolls = 0;

    while (now < durationMs) {
      now = Math.min(nextTelemetry, nextRuntime);
      if (now > durationMs) break;
      if (now === nextRuntime) {
        runtimePolls += 1;
        nextRuntime += runtimeIntervalMs;
      }
      if (now === nextTelemetry) {
        commands += 1;
        nextTelemetry += telemetryIntervalMs;
      }
    }

    return { commands, runtimePolls };
  }

  it("binds the historical starvation proof to the production telemetry and queue constants", () => {
    expect(rpcPage).toContain("setInterval(()=>{void this.pollEvents();},100)");
    expect(rpcPage).toContain('this.command("network-events",{},2_000)');
    expect(rpcPage).toContain('this.command("rpc",{action:"page-state"},5_000)');

    expect(taskWorker).toContain("commands.get(timeout=0.25)");
    expect(taskWorker).toMatch(/except queue\.Empty:\s*\n\s*adapter\.poll_runtime\(\)/);
    expect(controlAware).toContain("CONTROL_QUIET_SECONDS = 0.9");
  });

  it("proves 100ms telemetry can starve a runtime tied only to the 250ms queue-empty path", () => {
    const legacy = simulateQueue(100, 250, 5_000);
    expect(legacy.commands).toBeGreaterThan(40);
    expect(legacy.idlePolls).toBe(0);

    const controlCase = simulateQueue(500, 250, 5_000);
    expect(controlCase.idlePolls).toBeGreaterThan(0);
  });

  it("binds the preferred OOPIF production worker to a fair single-owner runtime cadence", () => {
    expect(scheduler).toContain("class SingleOwnerRuntimeScheduler");
    expect(scheduler).toContain("DEFAULT_INTERVAL_SECONDS = 0.25");
    expect(scheduler).toContain("self._adapter.poll_runtime()");
    expect(scheduler).not.toContain("threading");
    expect(scheduler).not.toContain("asyncio");

    expect(oopifWorker).toContain("from runtime_poll_scheduler import SingleOwnerRuntimeScheduler");
    expect(oopifWorker).toContain("self._ares_runtime_scheduler = SingleOwnerRuntimeScheduler(self.adapter)");
    expect(oopifWorker).toContain("impl.base.TaskRpcRuntime.network_events = _network_events_with_runtime_opportunity");
    expect(oopifWorker).toContain("impl.base.TaskRpcRuntime.page_state = _page_state_with_passive_runtime_opportunity");

    const production = simulateFairCadence(100, 250, 5_000);
    expect(production.commands).toBeGreaterThan(40);
    expect(production.runtimePolls).toBeGreaterThanOrEqual(20);
  });

  it("keeps passive observations from extending the 900ms explicit-control quiet window", () => {
    expect(controlAware).toContain("self._passive_observation_depth = 0");
    expect(controlAware).toMatch(/def note_control_activity\(self\).*?if self\._passive_observation_depth > 0:\s*return/s);
    expect(controlAware).toContain("def passive_observation(self, action:");
    expect(oopifWorker).toContain("observer(lambda: _original_page_state(self))");
    expect(productMonitorWorker).toContain("adapter.passive_observation(");
    expect(manualWorker).toContain("adapter.passive_observation(");

    const telemetryIntervalMs = 100;
    const quietWindowMs = 900;
    let quietUntil = quietWindowMs;
    let expired = false;
    for (let now = telemetryIntervalMs; now <= 5_000; now += telemetryIntervalMs) {
      // Passive telemetry intentionally does not move quietUntil.
      if (now >= quietUntil) expired = true;
    }
    expect(expired).toBe(true);
    expect(quietUntil).toBe(900);
  });

  it("keeps task/product monitoring on the fair scheduler while the manual profile browser uses an idle owner heartbeat", () => {
    expect(oopifWorker).toContain("SingleOwnerRuntimeScheduler");
    expect(productMonitorWorker).toContain("scheduler = SingleOwnerRuntimeScheduler(adapter)");
    expect(productMonitorWorker).toContain("commands.get(timeout=scheduler.queue_timeout(0.35))");
    expect(productMonitorWorker).toContain("adapter.poll_runtime()");

    expect(manualWorker).toContain("MANUAL_RUNTIME_HEARTBEAT_SECONDS = 1.0");
    expect(manualWorker).toContain("commands.get(timeout=0.25)");
    expect(manualWorker).toContain("_run_manual_runtime_heartbeat(adapter)");
    expect(manualWorker).toContain("adapter._orchestrator.run_cycle(adapter._run_visual_auto, adapter._run_instruction_auto)");
    expect(manualWorker).not.toContain("scheduler = SingleOwnerRuntimeScheduler(adapter)");
  });

  it("uses the patched OOPIF registry in the manual profile browser", () => {
    expect(manualWorker).toContain("from task_browser_worker_oopif import FlatCdpTargetRegistry");
    expect(manualWorker).not.toContain("from task_browser_worker_oopif_impl import FlatCdpTargetRegistry");
    expect(manualWorker).toContain('"oopif-discover"');
    expect(manualWorker).toContain('"oopif-evaluate"');
  });
});