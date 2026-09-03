const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1"
  ? describe
  : describe.skip;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  message = "condition"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

describeBrowserIntegration("browser worker watchdog integration", () => {
  jest.setTimeout(30_000);

  it("keeps a healthy worker alive and replaces an unresponsive child process", async () => {
    const compiled = require("../dist/backend/browser-worker/client.js") as {
      BrowserWorkerProcessClient: new (
        requestTimeoutMs: number,
        profileRoot: string | undefined,
        onExit: (client: unknown, error: Error) => void,
        heartbeatIntervalMs?: number,
        heartbeatTimeoutMs?: number,
        executeTimeoutMs?: number
      ) => {
        health(): Promise<{ pid?: number; running: boolean; lastHeartbeatAt?: Date }>;
        close(): Promise<void>;
      };
    };

    const exits: string[] = [];
    const client = new compiled.BrowserWorkerProcessClient(
      2_000,
      undefined,
      (_client, error) => exits.push(error.message),
      100,
      250,
      5_000
    );

    try {
      const first = await client.health();
      expect(first.running).toBe(true);
      expect(first.pid).toBeGreaterThan(0);

      const firstPid = first.pid as number;
      await delay(250);
      const healthyAgain = await client.health();
      expect(healthyAgain.pid).toBe(firstPid);
      expect(healthyAgain.lastHeartbeatAt).toBeInstanceOf(Date);

      if (process.platform === "win32") {
        // GitHub CI runs this test on Linux. Skip the SIGSTOP portion on Windows local runs.
        return;
      }

      process.kill(firstPid, "SIGSTOP");
      await waitFor(
        () => exits.some(message => message.includes("Heartbeat") || message.includes("Timeout")),
        5_000,
        "watchdog recycle"
      );

      const recovered = await client.health();
      expect(recovered.running).toBe(true);
      expect(recovered.pid).toBeGreaterThan(0);
      expect(recovered.pid).not.toBe(firstPid);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
