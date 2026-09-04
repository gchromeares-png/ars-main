import { createServer, type Socket } from "net";
import { mkdtemp, rm } from "fs/promises";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { PatchrightBrowserWorker } from "../src/browser-worker/patchright-browser-worker";

const describeBrowserIntegration = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1"
  ? describe
  : describe.skip;

function waitForListening(server: { once(event: "error", listener: (error: Error) => void): unknown; listen(port: number, host: string, callback: () => void): unknown }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: { close(callback: (error?: Error) => void): unknown }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function attachSocksConnection(client: Socket, observedHosts: string[]): void {
  let buffer = Buffer.alloc(0);
  let state: "greeting" | "request" | "tunnel" = "greeting";
  let upstream: Socket | undefined;

  const fail = () => client.destroy();

  client.on("data", chunk => {
    if (state === "tunnel") return;
    buffer = Buffer.concat([buffer, chunk]);

    if (state === "greeting") {
      if (buffer.length < 2) return;
      const methodsLength = buffer[1];
      const total = 2 + methodsLength;
      if (buffer.length < total) return;
      if (buffer[0] !== 0x05) return fail();
      buffer = buffer.subarray(total);
      client.write(Buffer.from([0x05, 0x00]));
      state = "request";
    }

    if (state !== "request" || buffer.length < 4) return;
    if (buffer[0] !== 0x05 || buffer[1] !== 0x01) return fail();

    const atyp = buffer[3];
    let offset = 4;
    let host = "";
    if (atyp === 0x03) {
      if (buffer.length < offset + 1) return;
      const length = buffer[offset];
      offset += 1;
      if (buffer.length < offset + length + 2) return;
      host = buffer.subarray(offset, offset + length).toString("utf8");
      offset += length;
    } else if (atyp === 0x01) {
      if (buffer.length < offset + 4 + 2) return;
      host = Array.from(buffer.subarray(offset, offset + 4)).join(".");
      offset += 4;
    } else {
      return fail();
    }

    const port = buffer.readUInt16BE(offset);
    offset += 2;
    const remainder = buffer.subarray(offset);
    buffer = Buffer.alloc(0);
    observedHosts.push(host);

    upstream = new Socket();
    upstream.once("connect", () => {
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      state = "tunnel";
      if (remainder.length) upstream?.write(remainder);
      client.pipe(upstream!);
      upstream!.pipe(client);
    });
    upstream.once("error", () => {
      client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      client.destroy();
    });

    // The test target is intentionally a local HTTP server. The SOCKS proxy
    // resolves/routes the requested hostname itself; Chrome must not resolve it.
    upstream.connect(port, "127.0.0.1");
  });

  client.on("error", () => undefined);
  client.on("close", () => upstream?.destroy());
}

describeBrowserIntegration("proxy DNS integration", () => {
  jest.setTimeout(60_000);

  it("sends an unresolvable destination hostname to SOCKS5 instead of resolving it locally", async () => {
    const destinationHost = "ares-remote-dns.invalid";
    const observedHosts: string[] = [];

    const httpServer = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>SOCKS Remote DNS</title><main id="host">${request.headers.host}</main>`);
    });
    await waitForListening(httpServer);
    const httpAddress = httpServer.address() as AddressInfo;

    const socksServer = createServer(client => attachSocksConnection(client, observedHosts));
    await waitForListening(socksServer);
    const socksAddress = socksServer.address() as AddressInfo;

    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ares-proxy-dns-"));
    const browserWorker = new PatchrightBrowserWorker();

    try {
      const handle = await browserWorker.createContext({
        taskId: "proxy-dns-integration",
        userDataDir,
        headless: true,
        proxy: {
          protocol: "socks5",
          host: "127.0.0.1",
          port: socksAddress.port
        },
        viewport: null,
        navigationTimeoutMs: 15_000,
        actionTimeoutMs: 5_000
      });

      const response = await handle.page.goto(
        `http://${destinationHost}:${httpAddress.port}/smoke`,
        { waitUntil: "domcontentloaded", timeout: 15_000 }
      );

      expect(response?.ok()).toBe(true);
      expect(await handle.page.title()).toBe("SOCKS Remote DNS");
      expect(observedHosts).toContain(destinationHost);
      expect(await handle.page.locator("#host").textContent()).toContain(destinationHost);
    } finally {
      await browserWorker.shutdown().catch(() => undefined);
      await closeServer(socksServer).catch(() => undefined);
      await closeServer(httpServer).catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
