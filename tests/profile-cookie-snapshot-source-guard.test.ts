import * as fs from "fs";
import * as path from "path";

describe("profile cookie snapshot architecture guard", () => {
  const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");
  const protocol = read("src/browser-worker/protocol.ts");
  const browserWorker = read("src/browser-worker/patchright-browser-worker.ts");
  const workerRuntime = read("src/browser-worker/worker.ts");
  const workerClient = read("src/browser-worker/client.ts");
  const electronService = read("src/app/services/electron.service.ts");
  const vault = read("src/cookies/profile-cookie-snapshot-vault.ts");
  const autoCheckout = read("src/monitor/auto-checkout-coordinator.ts");

  it("persists only a snapshot id in task data while carrying cookie payload outside Task", () => {
    expect(electronService).toContain("cookieSnapshotId");
    expect(protocol).toContain("cookieSnapshot?: ProfileCookieSnapshotCookie[]");
    expect(workerClient).toContain('task.config.data?.["cookieSnapshotId"]');
    expect(workerClient).toContain("cookieSnapshot\n      }, this.executeTimeoutFor(task))");
    expect(workerRuntime).toContain("browserCore.setTaskCookieSnapshot(request.task.id, request.cookieSnapshot)");
  });

  it("injects the explicitly selected snapshot before the executor receives the context", () => {
    const addCookiesAt = browserWorker.indexOf("handle.context.addCookies");
    const setContextAt = browserWorker.indexOf("this.contexts.set(config.taskId, handle)");
    expect(addCookiesAt).toBeGreaterThan(-1);
    expect(setContextAt).toBeGreaterThan(addCookiesAt);
  });

  it("stores cookie payload only as OS-encrypted ciphertext", () => {
    expect(vault).toContain("encryptString(JSON.stringify(normalizedCookies))");
    expect(vault).toContain("const ciphertext = this.crypto.encryptString");
    expect(vault).toContain("ciphertext\n    }");
    expect(vault).not.toContain("cookies: normalizedCookies");
  });

  it("propagates only cookieSnapshotId to auto-checkout children", () => {
    expect(autoCheckout).toContain("cookieSnapshotId?: string");
    expect(autoCheckout).toContain("{ cookieSnapshotId: action.cookieSnapshotId }");
    expect(autoCheckout).not.toContain("cookieSnapshot:");
  });
});
