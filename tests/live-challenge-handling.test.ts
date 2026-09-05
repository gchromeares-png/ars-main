import { LiveChallengeDetector } from "../src/challenges/live-challenge-detector";
import { LiveChallengeHandler } from "../src/challenges/live-challenge-handler";
import type { Page } from "../src/browser-worker/types";
import { ShopifyTaskExecutor } from "../src/shopify/shopify-task-executor";
import { Task, TaskState } from "../src/models";

describe("Live Challenge Handling in Browser", () => {
  describe("LiveChallengeDetector", () => {
    const detector = new LiveChallengeDetector();

    it("detects Cloudflare Turnstile from snapshot", () => {
      const html = '<div class="cf-turnstile" data-sitekey="0x4AAAAAA"><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile"></iframe></div>';
      const result = detector.detectFromSnapshot("https://shop.example.com/checkout", html);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("turnstile");
    });

    it("detects Google reCAPTCHA from snapshot", () => {
      const html = '<div class="g-recaptcha" data-sitekey="6Le-wbbSAAAA"><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></div>';
      const result = detector.detectFromSnapshot("https://shop.example.com/checkpoint", html);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("recaptcha");
    });

    it("detects hCaptcha from snapshot", () => {
      const html = '<div class="h-captcha" data-sitekey="10000000-ffff"><iframe src="https://newassets.hcaptcha.com/captcha/v1/"></iframe></div>';
      const result = detector.detectFromSnapshot("https://shop.example.com/checkpoint", html);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("hcaptcha");
    });

    it("detects Shopify Queue / Waiting Room from snapshot", () => {
      const html = '<div class="queue"><p>You are in line to check out. Please wait.</p><div data-poll-target="queue"></div></div>';
      const result = detector.detectFromSnapshot("https://shop.example.com/throttle/queue", html);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("shopify-queue");
    });

    it("detects Shopify Checkpoint from URL or form", () => {
      const html = '<form action="/checkpoint" method="post" id="checkpoint-form"><button type="submit">Submit</button></form>';
      const result = detector.detectFromSnapshot("https://shop.example.com/checkpoint", html);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("shopify-checkpoint");
    });

    it("detects Cloudflare Interstitial screen", () => {
      const html = '<div id="challenge-running"><p>Checking your browser before accessing...</p></div>';
      const result = detector.detectFromSnapshot("https://shop.example.com/checkout", html, "Just a moment...");
      expect(result.detected).toBe(true);
      expect(result.type).toBe("generic-interstitial");
    });

    it("returns detected=false for a regular checkout page", () => {
      const html = '<form class="edit_checkout"><input name="email" /><input name="firstName" /></form>';
      const result = detector.detectFromSnapshot("https://shop.example.com/checkouts/cn/c12345", html, "Checkout - Shop");
      expect(result.detected).toBe(false);
    });

    it("evaluates live Page accurately", async () => {
      const mockPage = {
        isClosed: () => false,
        url: () => "https://shop.example.com/checkpoint",
        evaluate: jest.fn().mockResolvedValue({
          detected: true,
          type: "turnstile",
          title: "Verify You Are Human",
          details: "Cloudflare Turnstile Challenge aktiv"
        })
      } as unknown as Page;

      const result = await detector.detect(mockPage);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("turnstile");
      expect(result.url).toBe("https://shop.example.com/checkpoint");
    });
  });

  describe("LiveChallengeHandler", () => {
    it("returns handled=false when no challenge is detected on the page", async () => {
      const detector = new LiveChallengeDetector();
      jest.spyOn(detector, "detect").mockResolvedValue({
        detected: false,
        url: "https://shop.example.com/checkouts/c1"
      });

      const handler = new LiveChallengeHandler(detector);
      const mockPage = {
        isClosed: () => false,
        url: () => "https://shop.example.com/checkouts/c1"
      } as unknown as Page;

      const result = await handler.handleLiveChallenge(mockPage);
      expect(result.handled).toBe(false);
      expect(result.resolved).toBe(true);
    });

    it("handles Turnstile challenge, clicks checkbox and detects resolution", async () => {
      const detector = new LiveChallengeDetector();
      jest.spyOn(detector, "detect").mockResolvedValue({
        detected: true,
        type: "turnstile",
        url: "https://shop.example.com/checkpoint"
      });

      const handler = new LiveChallengeHandler(detector);
      jest.spyOn(handler, "attemptTurnstileClick").mockResolvedValue(true);

      let checks = 0;
      jest.spyOn(handler, "checkIfResolved").mockImplementation(async () => {
        checks++;
        return checks >= 2;
      });

      const statusUpdates: string[] = [];
      const mockPage = {
        isClosed: () => false,
        bringToFront: jest.fn().mockResolvedValue(undefined),
        url: () => "https://shop.example.com/checkpoint"
      } as unknown as Page;

      const result = await handler.handleLiveChallenge(mockPage, {
        timeoutMs: 5_000,
        pollIntervalMs: 50,
        onStatusChange: (status) => statusUpdates.push(status)
      });

      expect(result.handled).toBe(true);
      expect(result.type).toBe("turnstile");
      expect(result.resolved).toBe(true);
      expect(statusUpdates.length).toBeGreaterThan(0);
      expect(statusUpdates[statusUpdates.length - 1]).toContain("erfolgreich gelöst");
    });

    it("returns error if challenge is not resolved before timeout", async () => {
      const detector = new LiveChallengeDetector();
      jest.spyOn(detector, "detect").mockResolvedValue({
        detected: true,
        type: "shopify-checkpoint",
        url: "https://shop.example.com/checkpoint"
      });

      const handler = new LiveChallengeHandler(detector);
      jest.spyOn(handler, "attemptCheckpointSubmit").mockResolvedValue(false);
      jest.spyOn(handler, "checkIfResolved").mockResolvedValue(false);

      const mockPage = {
        isClosed: () => false,
        bringToFront: jest.fn().mockResolvedValue(undefined),
        url: () => "https://shop.example.com/checkpoint"
      } as unknown as Page;

      const result = await handler.handleLiveChallenge(mockPage, {
        timeoutMs: 200,
        pollIntervalMs: 50
      });

      expect(result.handled).toBe(true);
      expect(result.resolved).toBe(false);
      expect(result.error).toContain("Timeout");
    });

    it("handles page closed during challenge", async () => {
      const detector = new LiveChallengeDetector();
      jest.spyOn(detector, "detect").mockResolvedValue({
        detected: true,
        type: "hcaptcha",
        url: "https://shop.example.com/checkpoint"
      });

      const handler = new LiveChallengeHandler(detector);
      let closed = false;
      const mockPage = {
        isClosed: () => {
          const was = closed;
          closed = true;
          return was;
        },
        bringToFront: jest.fn().mockResolvedValue(undefined),
        url: () => "https://shop.example.com/checkpoint"
      } as unknown as Page;

      const result = await handler.handleLiveChallenge(mockPage, {
        timeoutMs: 2_000,
        pollIntervalMs: 50
      });

      expect(result.handled).toBe(true);
      expect(result.resolved).toBe(false);
      expect(result.error).toContain("geschlossen");
    });
  });

  describe("ShopifyTaskExecutor challenge integration", () => {
    it("fails task cleanly if live challenge cannot be resolved", async () => {
      const product = {
        title: "Pokemon Booster",
        handle: "pokemon-booster",
        variants: [{ id: 101, title: "Default", price: "4.99", available: true }]
      };

      const mockPage = {
        isClosed: () => false,
        url: () => "https://shop.example.com/checkpoint",
        goto: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        off: jest.fn(),
        evaluate: jest.fn().mockImplementation(async (_fn: unknown, targetUrl?: string) => {
          const url = String(targetUrl ?? "");
          if (url.includes("/search/suggest.json")) {
            return {
              resources: {
                results: {
                  products: [{ title: product.title, handle: product.handle }]
                }
              }
            };
          }
          if (url.includes("/products/pokemon-booster.js")) {
            return product;
          }
          if (url.includes("/products.json")) {
            return { products: [product] };
          }
          return {};
        })
      } as unknown as Page;

      const mockBrowserWorker = {
        createContext: jest.fn().mockResolvedValue({
          taskId: "t-challenge-fail",
          context: {},
          page: mockPage,
          createdAt: new Date(),
          userDataDir: "/tmp/profile"
        }),
        closeContext: jest.fn().mockResolvedValue(undefined),
        health: jest.fn().mockResolvedValue({
          state: "healthy",
          activeContexts: 0,
          pendingCreations: 0,
          contextIds: [],
          startedAt: new Date(),
          uptimeMs: 100
        })
      };

      const mockLiveChallengeHandler = {
        handleLiveChallenge: jest.fn().mockResolvedValue({
          handled: true,
          type: "turnstile",
          resolved: false,
          durationMs: 1000,
          error: "Live-Challenge im Browser Timeout."
        })
      } as unknown as LiveChallengeHandler;

      const executor = new ShopifyTaskExecutor(
        (shopId) => ({ id: shopId, name: "Shop", baseUrl: "https://shop.example.com", platform: "shopify", config: {} }),
        () => ({
          id: "p1",
          name: "Test Profile",
          contact: { firstName: "Max", lastName: "Mustermann", email: "test@example.com" },
          address: { address1: "Hauptstr 1", city: "Berlin", postalCode: "10115", countryCode: "DE" }
        }),
        mockBrowserWorker,
        mockLiveChallengeHandler
      );

      const task: Task = {
        id: "t-challenge-fail",
        state: TaskState.RUNNING,
        config: {
          id: "t-challenge-fail",
          name: "Pokemon Booster",
          shopId: "shop-1",
          data: {
            profileId: "p1"
          }
        },
        retries: 0,
        maxRetries: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await executor.execute(task);
      expect(result).toBe(false);
      expect(task.lastError).toContain("Live-Challenge im Browser Timeout.");
      expect(mockBrowserWorker.closeContext).toHaveBeenCalledWith("t-challenge-fail");
    });
  });
});
