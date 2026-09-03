import type { BrowserContext, Page } from "patchright";

export type ProxyProtocol = "http" | "https" | "socks5";

export interface BrowserProxyConfig {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  bypass?: string;
}

export interface BrowserContextConfig {
  taskId: string;
  userDataDir: string;
  headless?: boolean;
  proxy?: BrowserProxyConfig;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  viewport?: { width: number; height: number } | null;
  args?: readonly string[];
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export interface BrowserContextHandle {
  readonly taskId: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly createdAt: Date;
  readonly userDataDir: string;
}

export type BrowserWorkerState = "starting" | "healthy" | "degraded" | "stopping" | "stopped";

export interface BrowserWorkerHealth {
  readonly state: BrowserWorkerState;
  readonly activeContexts: number;
  readonly pendingCreations: number;
  readonly contextIds: readonly string[];
  readonly startedAt: Date;
  readonly uptimeMs: number;
  readonly lastError?: string;
}
