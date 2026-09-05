import { SeleniumBaseBrowserWorker } from "./seleniumbase-browser-worker";

/**
 * Backwards-compatible class name for existing executor imports.
 * Runtime implementation is SeleniumBase Pure CDP; Patchright is no longer
 * instantiated or required by this worker.
 */
export class PatchrightBrowserWorker extends SeleniumBaseBrowserWorker {}
