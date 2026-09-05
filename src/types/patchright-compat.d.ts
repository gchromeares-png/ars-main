declare module "patchright" {
  export interface Response {
    url(): string;
    headers(): Record<string, string>;
    text(): Promise<string>;
  }

  export interface Locator {
    [key: string]: any;
    first(): Locator;
    nth(index: number): Locator;
    filter(options: { hasText?: string | RegExp }): Locator;
    count(): Promise<number>;
    isVisible(options?: { timeout?: number }): Promise<boolean>;
    isEnabled(options?: { timeout?: number }): Promise<boolean>;
    click(options?: Record<string, unknown>): Promise<void>;
    fill(value: string, options?: Record<string, unknown>): Promise<void>;
    inputValue(): Promise<string>;
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

  export interface Frame {
    [key: string]: any;
    locator(selector: string): Locator;
    getByRole(role: string, options?: { name?: string | RegExp }): Locator;
  }

  export interface FrameLocator {
    locator(selector: string): Locator;
    getByRole(role: string, options?: { name?: string | RegExp }): Locator;
  }

  export interface Page extends Frame {
    [key: string]: any;
    goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
    url(): string;
    title(): Promise<string>;
    isClosed(): boolean;
    frames(): Frame[];
    frameLocator(selector: string): FrameLocator;
    evaluate<T = unknown>(fn: ((...args: any[]) => T) | string, ...args: any[]): Promise<T>;
    waitForTimeout(ms: number): Promise<void>;
    waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>;
    bringToFront(): Promise<void>;
    on(event: "response", listener: (response: Response) => void): Page;
    off(event: "response", listener: (response: Response) => void): Page;
    mouse: {
      move(x: number, y: number): Promise<void>;
      click(x: number, y: number, options?: Record<string, unknown>): Promise<void>;
    };
  }

  export interface BrowserContext {
    addCookies(cookies: unknown[]): Promise<void>;
    close(): Promise<void>;
  }

  export const chromium: any;
}
