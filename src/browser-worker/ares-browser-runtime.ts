import { SeleniumBaseBrowserWorker } from "./seleniumbase-browser-worker";

/**
 * Single browser-runtime boundary for task/monitor sessions.
 *
 * Manual profile sessions and normal task sessions now share SeleniumBase Pure
 * CDP as the only active browser engine. Session ownership, leases, health,
 * cookies and shutdown stay in TypeScript; browser operations are delegated to
 * the Python SeleniumBase RPC worker.
 */
export class AresBrowserRuntime extends SeleniumBaseBrowserWorker {
  readonly runtimeId = "ares-browser-runtime" as const;
  readonly engine = "seleniumbase-cdp" as const;
}
