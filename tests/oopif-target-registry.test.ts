import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const repoRoot = path.resolve(__dirname, "..");
const pythonDir = path.join(repoRoot, "python", "seleniumbase_cdp");
const registryPath = path.join(pythonDir, "task_browser_worker_oopif.py");
const workerPath = path.join(repoRoot, "src", "browser-worker", "seleniumbase-browser-worker.ts");

function pythonExecutable(): string {
  return process.env["ARES_PYTHON_EXECUTABLE"]?.trim() || "python";
}

describe("OOPIF flattened CDP target registry", () => {
  const registry = fs.readFileSync(registryPath, "utf8");
  const worker = fs.readFileSync(workerPath, "utf8");

  it("enables child-session DOM and Runtime before recursive flattened auto-attach", () => {
    const domEnable = registry.indexOf('_send_command("DOM.enable"');
    const runtimeEnable = registry.indexOf('_send_command("Runtime.enable"');
    const autoAttach = registry.indexOf('"Target.setAutoAttach"');

    expect(domEnable).toBeGreaterThan(-1);
    expect(runtimeEnable).toBeGreaterThan(domEnable);
    expect(autoAttach).toBeGreaterThan(runtimeEnable);
    expect(registry).toContain('"flatten": True');
    expect(registry).toContain('"waitForDebuggerOnStart": False');
  });

  it("routes by live frame contexts and cannot let an old detach erase a replacement session", () => {
    const script = String.raw`
from task_browser_worker_oopif import FlatCdpTargetRegistry

registry = FlatCdpTargetRegistry("", autostart=False)
registry._register_session("root", "page-target", "page", generation=1)
registry._record_context("root", "frame-1", 10)
registry._register_session("old", "oopif-old", "iframe", generation=2)
registry._record_context("old", "frame-1", 20)
registry._register_session("new", "oopif-new", "iframe", generation=3)
registry._record_context("new", "frame-1", 30)
assert registry._route("frame-1")["sessionId"] == "new"
registry._detach_session("old")
assert registry._route("frame-1")["sessionId"] == "new"
registry._detach_session("new")
assert registry._route("frame-1")["sessionId"] == "root"
`;

    const result = spawnSync(pythonExecutable(), ["-c", script], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: pythonDir },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("prefers the OOPIF-aware worker but keeps the legacy worker as packaging fallback", () => {
    const oopif = worker.indexOf('const oopifWorker = "task_browser_worker_oopif.py"');
    const legacy = worker.indexOf('const legacyWorker = "task_browser_worker.py"');
    expect(oopif).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(oopif);
    expect(worker.indexOf('path.join(process.cwd(), "python", "seleniumbase_cdp", oopifWorker)'))
      .toBeLessThan(worker.indexOf('path.join(process.cwd(), "python", "seleniumbase_cdp", legacyWorker)'));
  });
});
