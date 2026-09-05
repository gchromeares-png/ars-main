export interface BrowserResponse {
  url(): string;
  headers(): Record<string, string>;
  text(): Promise<string>;
}

export interface BrowserLocator {
  [key: string]: any;
  first(): BrowserLocator;
  nth(index: number): BrowserLocator;
  filter(options: { hasText?: string | RegExp }): BrowserLocator;
  count(): Promise<number>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  isEnabled(options?: { timeout?: number }): Promise<boolean>;
  click(options?: Record<string, unknown>): Promise<void>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  inputValue(options?: { timeout?: number }): Promise<string>;
  innerText(options?: { timeout?: number }): Promise<string>;
  allTextContents(): Promise<string[]>;
  selectOption(value: string): Promise<unknown>;
  focus(): Promise<void>;
  scrollIntoViewIfNeeded(): Promise<void>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  evaluate<T = unknown>(fn: ((element: Element, ...args: any[]) => T) | string, ...args: any[]): Promise<T>;
  evaluateAll<T = unknown>(fn: ((elements: Element[], ...args: any[]) => T) | string, ...args: any[]): Promise<T>;
}

export interface BrowserFrame {
  [key: string]: any;
  locator(selector: string): BrowserLocator;
  getByRole(role: string, options?: { name?: string | RegExp }): BrowserLocator;
}

export interface BrowserFrameLocator {
  [key: string]: any;
  locator(selector: string): BrowserLocator;
  getByRole(role: string, options?: { name?: string | RegExp }): BrowserLocator;
}

export interface BrowserPage extends BrowserFrame {
  [key: string]: any;
  goto(url: string, options?: Record<string, unknown>): Promise<any>;
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  frames(): BrowserFrame[];
  mainFrame(): BrowserFrame;
  frameLocator(selector: string): BrowserFrameLocator;
  evaluate<T = unknown>(fn: ((...args: any[]) => T) | string, ...args: any[]): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>;
  bringToFront(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): BrowserPage;
  off(event: string, listener: (...args: any[]) => void): BrowserPage;
  mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number, options?: Record<string, unknown>): Promise<void>;
  };
}

export interface BrowserContext {
  addCookies(cookies: unknown[]): Promise<void>;
  addInitScript(script: { content: string } | string): Promise<void>;
  close(): Promise<void>;
}

// Short aliases keep the call sites readable while making the browser contract
// explicitly owned by ARES rather than any third-party automation library.
export type Response = BrowserResponse;
export type Locator = BrowserLocator;
export type Frame = BrowserFrame;
export type FrameLocator = BrowserFrameLocator;
export type Page = BrowserPage;

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
  readonly page: BrowserPage;
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
