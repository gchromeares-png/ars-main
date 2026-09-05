import { PatchrightBrowserWorker } from "./patchright-browser-worker";

/**
 * Single browser-runtime boundary for task/monitor sessions.
 *
 * All browser-owning task flows must depend on this class instead of creating
 * a concrete engine directly. The current task executor surface still consumes
 * Patchright Page/Context handles, so this class inherits the legacy backend
 * until those executors are migrated to the SeleniumBase RPC surface.
 */
export class AresBrowserRuntime extends PatchrightBrowserWorker {
  readonly runtimeId = "ares-browser-runtime" as const;
  readonly engine = "patchright-legacy" as const;
}
