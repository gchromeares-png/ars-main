import * as path from "path";
import type { BrowserWorker } from "./browser-worker";
import {
  BrowserContextAlreadyExistsError,
  BrowserProfileInUseError,
  BrowserWorkerStateError
} from "./errors";
import {
  acquireBrowserProfileLease,
  resolveProfileUserDataDir,
  type BrowserProfileLease
} from "./profile-session-manager";
import { launchBrowserContext } from "./patchright-launcher";
import type {
  BrowserContextConfig,
  BrowserContextHandle,
  BrowserWorkerHealth,
  BrowserWorkerState
} from "./types";

export class PatchrightBrowserWorker implements BrowserWorker {
  private readonly contexts = new Map<string, BrowserContextHandle>();
  private readonly pendingCreations = new Set<string>();
  private readonly activeProfileDirs = new Set<string>();
  private readonly taskProfileIds = new Map<string, string>();
  private readonly profileLeases = new Map<string, BrowserProfileLease>();
  private readonly startedAt = new Date();
  private state: BrowserWorkerState = "healthy";
  private lastError?: string;

  bindTaskProfile(taskId: string, profileId: string): void {
    const normalizedTaskId = String(taskId ?? "").trim();
    const normalizedProfileId = String(profileId ?? "").trim();
    if (!normalizedTaskId || !normalizedProfileId) throw new TypeError("taskId and profileId are required.");
    this.taskProfileIds.set(normalizedTaskId, normalizedProfileId);
  }

  unbindTaskProfile(taskId: string): void {
    this.taskProfileIds.delete(taskId);
  }

  getBoundProfileId(taskId: string): string | undefined {
    return this.taskProfileIds.get(taskId);
  }

  async createContext(config: BrowserContextConfig): Promise<BrowserContextHandle> {
    if (this.state !== "healthy") {
      throw new BrowserWorkerStateError(this.state);
    }
    if (this.contexts.has(config.taskId) || this.pendingCreations.has(config.taskId)) {
      throw new BrowserContextAlreadyExistsError(config.taskId);
    }

    const profileId = this.taskProfileIds.get(config.taskId);
    const requestedRoot = path.dirname(config.userDataDir);
    const effectiveUserDataDir = profileId
      ? resolveProfileUserDataDir(profileId, requestedRoot)
      : config.userDataDir;
    const normalizedDir = path.resolve(effectiveUserDataDir);
    if (this.activeProfileDirs.has(normalizedDir)) {
      throw new BrowserProfileInUseError(effectiveUserDataDir, `worker:${process.pid}:${config.taskId}`);
    }

    this.pendingCreations.add(config.taskId);
    this.activeProfileDirs.add(normalizedDir);

    let lease: BrowserProfileLease | undefined;
    try {
      lease = acquireBrowserProfileLease(normalizedDir, `worker:${process.pid}:${config.taskId}`);
      this.profileLeases.set(config.taskId, lease);

      const handle = await launchBrowserContext({
        ...config,
        userDataDir: normalizedDir
      });
      this.contexts.set(config.taskId, handle);
      this.lastError = undefined;
      return handle;
    } catch (error) {
      this.profileLeases.delete(config.taskId);
      lease?.release();
      this.activeProfileDirs.delete(normalizedDir);
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.pendingCreations.delete(config.taskId);
    }
  }

  async closeContext(taskId: string): Promise<void> {
    const handle = this.contexts.get(taskId);
    const lease = this.profileLeases.get(taskId);

    this.contexts.delete(taskId);
    this.profileLeases.delete(taskId);

    if (!handle) {
      lease?.release();
      return;
    }

    const normalizedDir = path.resolve(handle.userDataDir);
    this.activeProfileDirs.delete(normalizedDir);

    try {
      // Let Chromium close the persistent profile directly so Cookies, History,
      // Preferences and storage can be flushed coherently. Do not close pages first.
      await handle.context.close();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      lease?.release();
    }
  }

  async health(): Promise<BrowserWorkerHealth> {
    return {
      state: this.state,
      activeContexts: this.contexts.size,
      pendingCreations: this.pendingCreations.size,
      contextIds: [...this.contexts.keys()],
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt.getTime(),
      lastError: this.lastError
    };
  }

  getContext(taskId: string): BrowserContextHandle | undefined {
    return this.contexts.get(taskId);
  }

  async shutdown(): Promise<void> {
    if (this.state === "stopping" || this.state === "stopped") return;
    this.state = "stopping";

    const handles = [...this.contexts.entries()];
    this.contexts.clear();
    this.activeProfileDirs.clear();
    this.taskProfileIds.clear();

    const results = await Promise.allSettled(
      handles.map(async ([taskId, handle]) => {
        try {
          await handle.context.close();
        } finally {
          this.profileLeases.get(taskId)?.release();
          this.profileLeases.delete(taskId);
        }
      })
    );

    for (const lease of this.profileLeases.values()) lease.release();
    this.profileLeases.clear();

    const failed = results.filter(result => result.status === "rejected");
    if (failed.length > 0) {
      this.lastError = `${failed.length} browser context(s) failed to close cleanly.`;
    }
    this.state = "stopped";
  }
}
