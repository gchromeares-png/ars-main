"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.env.ARES_UI_E2E_MODE !== "1") {
  throw new Error("ARES_UI_E2E_MODE=1 is required for the Windows UI runtime proof.");
}

const proofRoot = path.resolve(process.env.ARES_UI_E2E_ARTIFACT_DIR || path.join(os.tmpdir(), "ares-windows-ui-runtime-proof"));
const runnerTimeline = path.join(proofRoot, "runner-timeline.jsonl");
fs.mkdirSync(proofRoot, { recursive: true });

function checkpoint(event, data = {}) {
  const record = {
    ts: new Date().toISOString(),
    event,
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    type: process.type || null,
    electron: process.versions?.electron || null,
    node: process.versions?.node || null,
    ...data
  };
  const line = `${JSON.stringify(record)}\n`;
  fs.appendFileSync(runnerTimeline, line, "utf8");
  process.stdout.write(`[ARES-UI-E2E-RUNNER] ${line}`);
}

process.on("uncaughtException", error => {
  checkpoint("runner-uncaught-exception", { error: String(error?.stack || error) });
  process.exitCode = 1;
});
process.on("unhandledRejection", error => {
  checkpoint("runner-unhandled-rejection", { error: String(error?.stack || error) });
  process.exitCode = 1;
});
process.on("exit", code => checkpoint("runner-exit", { code }));

checkpoint("runner-start", { argv: process.argv, cwd: process.cwd(), proofRoot });
checkpoint("runner-before-bootstrap-require");
require("./windows-ui-runtime-e2e.bootstrap.cjs");
checkpoint("runner-after-bootstrap-require");
checkpoint("runner-before-production-main-require");
require("../dist/backend/electron/main.js");
checkpoint("runner-after-production-main-require");
