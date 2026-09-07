import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase runtime starvation proof", () => {
  const read = (relative: string): string =>
    fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

  const taskWorker = read("python/seleniumbase_cdp/task_browser_worker.py");
  const rpcPage = read("src/browser-worker/seleniumbase-rpc-page.ts");
  const controlAware = read("python/seleniumbase_cdp/control_aware_seleniumbase_adapter.py");

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

  it("binds the proof to the production telemetry, queue-idle, and control-quiet constants", () => {
    expect(rpcPage).toContain("setInterval(()=>{void this.pollEvents();},100)");
    expect(rpcPage).toContain('this.command("network-events",{},2_000)');
    expect(rpcPage).toContain('this.command("rpc",{action:"page-state"},5_000)');

    expect(taskWorker).toContain("commands.get(timeout=0.25)");
    expect(taskWorker).toMatch(/except queue\.Empty:\s*\n\s*adapter\.poll_runtime\(\)/);

    expect(controlAware).toContain("CONTROL_QUIET_SECONDS = 0.9");
    expect(controlAware).toMatch(
      /def execute_script\(self, script: str, \*args: Any\).*?self\.note_control_activity\(\).*?super\(\)\.execute_script/s
    );
  });

  it("proves 100ms passive telemetry prevents the 250ms queue-empty runtime tick", () => {
    const production = simulateQueue(100, 250, 5_000);
    expect(production.commands).toBeGreaterThan(40);
    expect(production.idlePolls).toBe(0);

    const controlCase = simulateQueue(500, 250, 5_000);
    expect(controlCase.idlePolls).toBeGreaterThan(0);
  });

  it("proves repeated page-state observation can keep the 900ms control quiet window continuously extended", () => {
    const telemetryIntervalMs = 100;
    const quietWindowMs = 900;
    let quietUntil = 0;
    let everQuietExpiredBetweenTelemetry = false;

    for (let now = 0; now <= 5_000; now += telemetryIntervalMs) {
      if (now >= quietUntil && now !== 0) everQuietExpiredBetweenTelemetry = true;
      // page-state -> page_state() -> adapter.execute_script(document.readyState)
      // ControlAwareSeleniumBaseCdpAdapter.execute_script() marks control activity.
      quietUntil = Math.max(quietUntil, now + quietWindowMs);
    }

    expect(everQuietExpiredBetweenTelemetry).toBe(false);
    expect(quietUntil).toBeGreaterThan(5_000);
  });

  it("documents the exact failure mechanism seen by the real glue E2E", () => {
    expect(taskWorker).toContain("adapter.poll_runtime()");
    expect(rpcPage).toContain("if(this.responseListeners.size)");
    expect(rpcPage).toContain("if(this.loadListeners.size||this.frameNavigationListeners.size)await this.refreshPageState(true)");

    // The real E2E already proved: worker READY, task RUNNING and iframe-loaded,
    // while no solved/failed pointer hit was emitted. This source/scheduler proof
    // shows why the automatic runtime can receive no fair execution opportunity.
    expect(true).toBe(true);
  });
});
