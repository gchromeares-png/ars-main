import { mkdtemp, rm } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ProxyHealthService, parseProxycheckResponse } from "../src/proxies/proxy-health-service";
import { ProxyRepository } from "../src/proxies/proxy-repository";
import type { AresProxy } from "../src/proxies/models";

const proxy: AresProxy = {
  id: "de-resi-01",
  name: "DE Residential 01",
  protocol: "http",
  host: "proxy.example.test",
  port: 8080,
  username: "user",
  password: "pass"
};

describe("ProxyHealthService", () => {
  it("parses keyless proxycheck.io risk, geo and spam history", () => {
    const parsed = parseProxycheckResponse("203.0.113.10", {
      status: "ok",
      "203.0.113.10": {
        asn: "AS64500",
        provider: "Example Network",
        country: "Germany",
        isocode: "DE",
        region: "Hamburg",
        city: "Hamburg",
        latitude: 53.55,
        longitude: 10,
        proxy: "yes",
        type: "Residential",
        risk: 27,
        "last seen human": "2 days ago",
        "attack history": {
          Total: 12,
          "Comment Spam": 3,
          "Forum Spam": 2,
          "Login Attempt": 7
        }
      }
    });

    expect(parsed.geo).toEqual(expect.objectContaining({
      country: "Germany",
      countryCode: "DE",
      region: "Hamburg",
      city: "Hamburg",
      provider: "Example Network",
      asn: "AS64500"
    }));
    expect(parsed.reputation).toEqual(expect.objectContaining({
      source: "proxycheck.io",
      available: true,
      riskScore: 27,
      riskLevel: "low",
      attackTotal: 12,
      spamHits: 5,
      proxyDetected: true,
      detectedType: "Residential"
    }));
  });

  it("keeps a successful proxy probe online even when reputation is unavailable", async () => {
    const service = new ProxyHealthService({
      probeExitIp: jest.fn(async () => ({ exitIp: "203.0.113.20", latencyMs: 84 })),
      lookupReputation: jest.fn(async () => ({
        reputation: { source: "proxycheck.io" as const, available: false, error: "daily limit" }
      }))
    });

    await expect(service.test(proxy)).resolves.toEqual(expect.objectContaining({
      proxyId: proxy.id,
      status: "online",
      exitIp: "203.0.113.20",
      latencyMs: 84,
      reputation: expect.objectContaining({ available: false, error: "daily limit" })
    }));
  });

  it("marks the proxy offline when the direct proxy probe fails", async () => {
    const service = new ProxyHealthService({
      probeExitIp: jest.fn(async () => { throw new Error("connect ECONNREFUSED"); })
    });

    const result = await service.test(proxy);
    expect(result.status).toBe("offline");
    expect(result.exitIp).toBeUndefined();
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("persists the last health result with the proxy vault", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ares-proxy-health-"));
    const file = path.join(directory, "proxies.json");
    try {
      const repository = new ProxyRepository(file);
      repository.save({
        ...proxy,
        health: {
          proxyId: proxy.id,
          status: "online",
          checkedAt: "2026-09-03T18:00:00.000Z",
          latencyMs: 63,
          exitIp: "203.0.113.30",
          geo: { countryCode: "DE", city: "Hamburg" },
          reputation: { source: "proxycheck.io", available: true, riskScore: 9, riskLevel: "low", spamHits: 0 }
        }
      });

      const restored = new ProxyRepository(file).get(proxy.id);
      expect(restored?.health).toEqual(expect.objectContaining({
        status: "online",
        latencyMs: 63,
        exitIp: "203.0.113.30"
      }));
      expect(restored?.health?.reputation?.riskScore).toBe(9);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
