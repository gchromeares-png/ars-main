import * as http from "http";
import { PassiveHttpPreCheckoutGate } from "../src/monitor/pre-checkout-gate";
import { TaskState, type Task } from "../src/models";
import type { CommerceShop } from "../src/commerce/platforms";

function makeTask(baseUrl: string): { task: Task; shop: CommerceShop } {
  const now = new Date();
  return {
    task: {
      id: "gate-monitor",
      config: {
        id: "gate-monitor",
        name: "Pokemon Center Gate",
        shopId: "pokemon-center-de",
        data: {
          monitorStrategy: {
            mode: "early-gate",
            productName: "Pokemon Center ETB",
            discoveryKeywords: ["ETB"]
          }
        }
      },
      state: TaskState.RUNNING,
      createdAt: now,
      updatedAt: now,
      retries: 0,
      maxRetries: 0
    },
    shop: {
      id: "pokemon-center-de",
      name: "Pokemon Center DE",
      baseUrl,
      platform: "custom",
      config: {}
    }
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Test server address missing"));
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

describe("PassiveHttpPreCheckoutGate", () => {
  it("treats Incapsula_Resource as passive queue telemetry and extracts pos/ttw when present", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><script src="/Incapsula_Resource?pos=123&ttw=45"></script></html>');
    });
    const port = await listen(server);
    try {
      const { task, shop } = makeTask(`http://127.0.0.1:${port}/`);
      const gate = new PassiveHttpPreCheckoutGate({ timeoutMs: 2_000 });
      const event = await gate.evaluate(task, shop);

      expect(event).toMatchObject({
        type: "queue-signal",
        source: "incapsula-resource",
        position: 123,
        timeToWaitSeconds: 45
      });
    } finally {
      await close(server);
    }
  });

  it("does not require pos/ttw for queue detection", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><script src="/Incapsula_Resource"></script></html>');
    });
    const port = await listen(server);
    try {
      const { task, shop } = makeTask(`http://127.0.0.1:${port}/`);
      const gate = new PassiveHttpPreCheckoutGate({ timeoutMs: 2_000 });
      const event = await gate.evaluate(task, shop);

      expect(event?.type).toBe("queue-signal");
      expect(event?.position).toBeUndefined();
      expect(event?.timeToWaitSeconds).toBeUndefined();
    } finally {
      await close(server);
    }
  });
});
