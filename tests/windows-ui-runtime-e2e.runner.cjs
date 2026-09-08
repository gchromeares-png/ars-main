"use strict";

// Real Electron E2E entrypoint. Running this file with the Electron executable
// guarantees that Electron's app/BrowserWindow APIs exist before the proof
// bootstrap is registered. The bootstrap observes the production window and
// drives the real renderer; production main.ts remains unchanged.
if (process.env.ARES_UI_E2E_MODE !== "1") {
  throw new Error("ARES_UI_E2E_MODE=1 is required for the Windows UI runtime proof.");
}

require("./windows-ui-runtime-e2e.bootstrap.cjs");
require("../dist/backend/electron/main.js");
