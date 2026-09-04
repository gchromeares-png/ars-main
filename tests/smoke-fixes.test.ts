import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BrowserWorkerPoolClient } from "../src/browser-worker/client";
import { ProfileRepository } from "../src/profiles/profile-repository";
import { TaskOrchestrator } from "../src/orchestrator";
import { TaskRepositoryMock } from "../src/mocks";
import { TaskState } from "../src/models";
import { AresProfile } from "../src/profiles/models";

describe("Smoke Tests for System Fixes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ares-smoke-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Bug 1: Worker-Load-Leak in client.ts", () => {
    it("cleans up taskIds and taskOwners on successful task execution", async () => {
      const dummyProfile: AresProfile = {
        id: "p1",
        name: "Profile 1",
        contact: { firstName: "John", lastName: "Doe", email: "john@example.com" },
        address: { address1: "Street 1", postalCode: "12345", city: "Berlin", countryCode: "DE" }
      };

      const pool = new BrowserWorkerPoolClient(
        () => ({ id: "shop1", name: "Shop", baseUrl: "https://example.com", platform: "shopify", config: {} }),
        () => dummyProfile
      );

      const workerClient = (pool as any).leastLoadedClient();
      const readySpy = jest.spyOn(workerClient as any, "ensureReady").mockResolvedValue(undefined);
      const requestSpy = jest.spyOn(workerClient as any, "request").mockImplementation(async (request: any) => {
        if (request?.type === "set-final-purchase-permission") {
          return {
            type: "ack",
            requestId: request.requestId
          };
        }

        return {
          type: "execute-result",
          requestId: request?.requestId ?? "req-1",
          success: true,
          taskPatch: {
            config: {},
            lastError: undefined
          }
        };
      });

      const task: any = {
        id: "task-101",
        shopId: "shop1",
        profileId: "p1",
        config: {
          id: "task-101",
          name: "Test Task",
          shopId: "shop1",
          data: { profileId: "p1" }
        }
      };

      const success = await pool.execute(task);
      expect(success).toBe(true);

      // Verify taskOwners in pool is empty
      expect((pool as any).taskOwners.size).toBe(0);
      // Verify taskIds in client is cleaned up in finally block
      expect((workerClient as any).taskIds.has("task-101")).toBe(false);

      readySpy.mockRestore();
      requestSpy.mockRestore();
    });
  });

  describe("Bug 2: Retry-Race Condition in orchestrator/index.ts", () => {
    it("does not prematurely transition RETRYING tasks to QUEUED synchronously", () => {
      const orchestrator = new TaskOrchestrator(
        new TaskRepositoryMock(),
        {
          execute: async () => false,
          cancelTask: async () => {}
        } as any
      );

      const task = orchestrator.createTask({
        id: "task-race-1",
        name: "Retry Task",
        shopId: "shop1"
      });

      // Move task to FAILED so it can transition to RETRYING
      (orchestrator as any).transition(task, TaskState.STARTING);
      (orchestrator as any).transition(task, TaskState.RUNNING);
      (orchestrator as any).transition(task, TaskState.FAILED);

      let retryingEmittedDirectly = false;
      orchestrator.on("taskRetrying", (t: any) => {
        if (t.id === task.id) {
          retryingEmittedDirectly = true;
        }
      });

      // Transition to RETRYING
      (orchestrator as any).transition(task, TaskState.RETRYING);

      // Verify state is RETRYING
      expect(task.state).toBe(TaskState.RETRYING);
      // Verify taskRetrying was NOT emitted directly by transition()
      expect(retryingEmittedDirectly).toBe(false);
    });
  });

  describe("Bug 3: Shopify Executor Header & Proxy Leak Prevention", () => {
    it("uses authentic browser User-Agent rather than bot-flagged ARES/1.0", () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, "../src/shopify/patchright-shopify-executor.ts"),
        "utf8"
      );
      expect(source).not.toContain('"User-Agent": "ARES/1.0"');
      expect(source).toContain("Mozilla/5.0");
      expect(source).toContain("page.evaluate");
    });
  });

  describe("Bug 4: IPC Listener Cleanup", () => {
    it("preload provides removeTaskStatusListener and clean unsubscription", () => {
      const preloadSource = fs.readFileSync(
        path.resolve(__dirname, "../src/electron/preload.ts"),
        "utf8"
      );
      expect(preloadSource).toContain("removeTaskStatusListener");
      expect(preloadSource).toContain("taskStatusListeners");
      expect(preloadSource).toContain("removeListener");
    });
  });

  describe("Bug 5: ProfileRepository File Persistence", () => {
    it("loads and saves profiles to disk when storagePath is specified", () => {
      const storageFile = path.join(tempDir, "profiles.json");
      const repo1 = new ProfileRepository(storageFile);

      const profile: AresProfile = {
        id: "profile-disk-1",
        name: "Test Profile",
        contact: {
          firstName: "Max",
          lastName: "Mustermann",
          email: "disk@example.com"
        },
        address: {
          address1: "Hauptstr 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE"
        }
      };

      repo1.save(profile);
      expect(fs.existsSync(storageFile)).toBe(true);

      // Re-read from new repository instance
      const repo2 = new ProfileRepository(storageFile);
      const loaded = repo2.get("profile-disk-1");
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe("Test Profile");
      expect(loaded?.contact.email).toBe("disk@example.com");

      // Delete and verify disk update
      repo2.delete("profile-disk-1");
      const repo3 = new ProfileRepository(storageFile);
      expect(repo3.get("profile-disk-1")).toBeUndefined();
    });
  });

  describe("Bug 6: Chrome Channel Resiliency", () => {
    it("has fallback when launching persistent context", () => {
      const launcherSource = fs.readFileSync(
        path.resolve(__dirname, "../src/browser-worker/patchright-launcher.ts"),
        "utf8"
      );
      expect(launcherSource).toContain('channel: "chrome"');
      expect(launcherSource).toContain("catch (channelError)");
      expect(launcherSource).toContain("chromium.launchPersistentContext(config.userDataDir, launchOptions)");
    });
  });
});
