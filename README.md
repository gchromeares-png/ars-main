# ARES — Patchright External Browser Worker

ARES uses Electron/Angular for the desktop UI and orchestration while all Patchright browser work runs in external system-Node worker processes.

## Browser stack

- Patchright only; no Puppeteer / puppeteer-core.
- Google Chrome forced by `channel: "chrome"`.
- Persistent, task-specific browser profiles and storage.
- Per-profile proxy routing.
- `ghost-cursor` used only as a Bézier path generator for standardized UI interaction tests; Patchright `page.mouse` dispatches events.
- Final payment/order submission remains disabled.

## Why the external worker exists

Electron 21 embeds Node 16.16.0, while current Patchright requires Node 20+. ARES therefore launches `dist/backend/browser-worker/worker.js` with the system `node` executable. Electron never imports Patchright at runtime.

## Install / build / test

```bat
node -v
npm install
npm run browser:install
npm run build:backend
npm run build:ui
npm test -- --runInBand
npm run electron
```

Use Node 20 or newer for `npm` and the browser worker.

If needed, pin the worker executable explicitly:

```bat
set ARES_NODE_EXECUTABLE=C:\Program Files\nodejs\node.exe
```

## Parallel sessions

The orchestrator exposes four logical task slots by default. One external browser-worker process can manage several isolated task contexts concurrently, so process count defaults to 1 to avoid unnecessary resource use.

Optional scaling:

```bat
set ARES_MAX_CONCURRENT_TASKS=4
set ARES_BROWSER_WORKER_PROCESSES=2
```

`ARES_BROWSER_WORKER_PROCESSES` is capped at 4. New tasks are routed to the least-loaded process and cancellation is routed back to the process that owns the task.

See `MIGRATION-PATCHRIGHT.md` for the lifecycle and RPC design.
