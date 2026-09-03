import * as path from "path";
import type { BrowserWorker } from "./browser-worker";
import {
  BrowserContextAlreadyExistsError,
  BrowserProfileInUseError,
  BrowserWorkerStateError
} from "./errors";
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
  private readonly startedAt = new Date();
  private state: BrowserWorkerState = "healthy";
  private lastError?: string;

  async createContext(config: BrowserContextConfig): Promise<BrowserContextHandle> {
    if (this.state !== "healthy") {
      throw new BrowserWorkerStateError(this.state);
    }
    if (this.contexts.has(config.taskId) || this.pendingCreations.has(config.taskId)) {
      throw new BrowserContextAlreadyExistsError(config.taskId);
    }

    const normalizedDir = path.resolve(config.userDataDir);
    if (this.activeProfileDirs.has(normalizedDir)) {
      throw new BrowserProfileInUseError(config.userDataDir);
    }

    this.pendingCreations.add(config.taskId);
    this.activeProfileDirs.add(normalizedDir);

    try {
      const handle = await launchBrowserContext(config);
      this.contexts.set(config.taskId, handle);
      this.lastError = undefined;
      return handle;
    } catch (error) {
      this.activeProfileDirs.delete(normalizedDir);
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.pendingCreations.delete(config.taskId);
    }
  }

  async closeContext(taskId: string): Promise<void> {
    const handle = this.contexts.get(taskId);
    if (!handle) return;

    this.contexts.delete(taskId);
    const normalizedDir = path.resolve(handle.userDataDir);
    this.activeProfileDirs.delete(normalizedDir);

    try {
      const pages = handle.context.pages();
      await Promise.allSettled(pages.map(p => p.close().catch(() => undefined)));
      await handle.context.close();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
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

    const handles = [...this.contexts.values()];
    this.contexts.clear();
    this.activeProfileDirs.clear();

    const results = await Promise.allSettled(
      handles.map(async handle => {
        const pages = handle.context.pages();
        await Promise.allSettled(pages.map(p => p.close().catch(() => undefined)));
        await handle.context.close();
      })
    );

    const failed = results.filter(result => result.status === "rejected");
    if (failed.length > 0) {
      this.lastError = `${failed.length} browser context(s) failed to close cleanly.`;
    }
    this.state = "stopped";
  }
}
