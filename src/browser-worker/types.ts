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

export type BrowserOsFamily = "windows" | "macos" | "linux" | "android" | "ios" | "unknown";
export type BrowserEnvironmentStatus = "green" | "warning";

export interface BrowserEnvironmentIssue {
  readonly code: string;
  readonly message: string;
}

export interface BrowserEnvironmentSnapshot {
  readonly userAgent: string;
  readonly platform: string;
  readonly language: string;
  readonly languages: readonly string[];
  readonly timezone: string;
  readonly hardwareConcurrency: number;
  readonly deviceMemory: number | null;
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly availWidth: number;
    readonly availHeight: number;
    readonly colorDepth: number;
    readonly pixelDepth: number;
    readonly devicePixelRatio: number;
  };
  readonly webglVendor: string;
  readonly webglRenderer: string;
}

export interface BrowserEnvironmentAudit {
  readonly version: 1;
  readonly status: BrowserEnvironmentStatus;
  readonly checkedAt: string;
  readonly userAgentOs: BrowserOsFamily;
  readonly platformOs: BrowserOsFamily;
  readonly snapshot: BrowserEnvironmentSnapshot;
  readonly issues: readonly BrowserEnvironmentIssue[];
}

export interface BrowserContextHandle {
  readonly taskId: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly createdAt: Date;
  readonly userDataDir: string;
  readonly environmentAudit: BrowserEnvironmentAudit;
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
