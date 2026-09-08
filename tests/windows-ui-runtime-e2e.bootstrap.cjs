"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

if (process.env.ARES_UI_E2E_MODE === "1" && process.versions?.electron && process.type === "browser") {
  const { app, BrowserWindow } = require("electron");

  const PROFILE_ID = "windows-ui-runtime-e2e-profile";
  const PROFILE_NAME = "Windows UI Runtime E2E";
  const SHOP_ID = "windows-ui-runtime-e2e-shop";
  const TASK_ID = "windows-ui-runtime-e2e-task";
  const EXPECTED = [1, 4, 7];
  const proofRoot = path.resolve(process.env.ARES_UI_E2E_ARTIFACT_DIR || path.join(os.tmpdir(), "ares-windows-ui-runtime-proof"));
  const screenshotsDir = path.join(proofRoot, "screenshots");
  const cropsDir = path.join(screenshotsDir, "grid-crops");
  const traceOut = path.join(proofRoot, "runtime");
  const timelinePath = path.join(proofRoot, "timeline.jsonl");
  const userData = path.resolve(process.env.ARES_UI_E2E_USER_DATA || path.join(os.tmpdir(), "ares-windows-ui-runtime-user-data"));
  fs.mkdirSync(cropsDir, { recursive: true });
  fs.mkdirSync(traceOut, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);

  const hits = [];
  const visionCalls = [];
  let mainServer;
  let frameServer;
  let visionServer;
  let finished = false;

  const proof = (event, data = {}) => {
    const record = { ts: new Date().toISOString(), event, ...data };
    fs.appendFileSync(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    process.stdout.write(`[ARES-UI-E2E] ${JSON.stringify(record)}\n`);
  };

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function waitFor(read, timeoutMs, label, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await read();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message || lastError}` : ""}`);
  }

  function send(response, body, type = "text/html; charset=utf-8") {
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  }

  async function listen(server, host) {
    await new Promise((resolve, reject) => server.listen(0, host, resolve).once("error", reject));
    return server.address().port;
  }

  async function closeServer(server) {
    if (!server) return;
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  function createServers() {
    const token = "windows-ui-runtime-e2e-token";
    visionServer = http.createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        send(response, JSON.stringify({ ready: true, model: "windows-ui-runtime-e2e" }), "application/json");
        return;
      }
      if (request.method !== "POST" || request.url !== "/classify") {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const sources = Array.isArray(payload.sources) ? payload.sources : [];
        visionCalls.push({ instruction: String(payload.instruction || ""), sources });
        proof("vision-classify", { instruction: String(payload.instruction || ""), tileCount: sources.length });
        if (!String(payload.instruction || "").toLowerCase().includes("fahrr")) {
          response.writeHead(422).end("instruction mismatch");
          return;
        }
        if (sources.length !== 9 || !sources.every(source => String(source).startsWith("data:image/png;base64,"))) {
          response.writeHead(422).end("crop mismatch");
          return;
        }
        send(response, JSON.stringify({
          selectedIndexes: EXPECTED,
          scores: [0.1, 0.9, 0.1, 0.1, 0.95, 0.1, 0.1, 0.92, 0.1],
          rawLogits: [-2, 2, -2, -2, 2.2, -2, -2, 2.1, -2],
          model: "windows-ui-runtime-e2e",
          target: "fahrräder",
          threshold: 0.5,
          selectionPolicy: "windows-ui-runtime-e2e"
        }), "application/json");
      });
    });

    frameServer = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname === "/frame-loaded") {
        hits.push({ type: "frame-loaded" });
        send(response, "ok", "text/plain; charset=utf-8");
        return;
      }
      if (url.pathname === "/solved" || url.pathname === "/failed") {
        const hit = {
          type: url.pathname === "/solved" ? "solved" : "failed",
          trusted: url.searchParams.get("trusted") || "",
          selected: url.searchParams.get("selected") || "",
          clicks: url.searchParams.get("clicks") || ""
        };
        hits.push(hit);
        proof(`fixture-${hit.type}`, hit);
        send(response, "ok", "text/plain; charset=utf-8");
        return;
      }
      send(response, `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:#fff;font-family:Arial,sans-serif}main{padding:28px;width:420px}
        p{font-size:20px;margin:0 0 18px}section{display:grid;grid-template-columns:repeat(3,112px);gap:10px}
        section>div{width:112px;height:112px;border-radius:8px;box-shadow:inset 0 0 0 1px #888;cursor:pointer}
        section>div:nth-child(1){background:linear-gradient(135deg,#ddd,#999)}section>div:nth-child(2){background:linear-gradient(135deg,#2f7d32,#9ccc65)}
        section>div:nth-child(3){background:linear-gradient(135deg,#b0bec5,#607d8b)}section>div:nth-child(4){background:linear-gradient(135deg,#ffcc80,#ef6c00)}
        section>div:nth-child(5){background:linear-gradient(135deg,#388e3c,#c5e1a5)}section>div:nth-child(6){background:linear-gradient(135deg,#90caf9,#1565c0)}
        section>div:nth-child(7){background:linear-gradient(135deg,#ce93d8,#7b1fa2)}section>div:nth-child(8){background:linear-gradient(135deg,#43a047,#dcedc8)}
        section>div:nth-child(9){background:linear-gradient(135deg,#ef9a9a,#c62828)}section>div[data-selected="1"]{outline:5px solid #111;outline-offset:-5px}
        button{margin-top:18px;width:150px;height:48px;font-size:17px}strong{display:block;margin-top:18px;font-size:20px}
      </style></head><body><main><p>Wähle alle Bilder mit Fahrrädern aus</p>
        <section><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div></section>
        <button type="submit">Bestätigen</button>
      </main><script>(()=>{fetch('/frame-loaded').catch(()=>{});const expected=[1,4,7],selected=new Set();let trustedClicks=0;
        const tiles=Array.from(document.querySelectorAll('section > div'));tiles.forEach((tile,index)=>tile.addEventListener('click',event=>{
          if(event.isTrusted!==true)return;trustedClicks+=1;if(selected.has(index))selected.delete(index);else selected.add(index);tile.dataset.selected=selected.has(index)?'1':'0';
        }));document.querySelector('button').addEventListener('click',event=>{if(event.isTrusted!==true)return;trustedClicks+=1;
          const actual=Array.from(selected).sort((a,b)=>a-b),ok=JSON.stringify(actual)===JSON.stringify(expected);if(ok){const done=document.createElement('strong');done.textContent='Erfolgreich verifiziert';document.querySelector('main').appendChild(done);}
          fetch((ok?'/solved':'/failed')+'?trusted=true&selected='+encodeURIComponent(actual.join(','))+'&clicks='+trustedClicks).catch(()=>{});
        });})();</script></body></html>`);
    });

    mainServer = http.createServer((_request, response) => {
      const framePort = frameServer.address().port;
      const frameUrl = `http://localhost:${framePort}/frame`;
      send(response, `<!doctype html><html><head><title>ARES Windows UI Runtime Grid</title></head><body><main>Produktseite bereit</main><iframe src=${JSON.stringify(frameUrl)} style="width:650px;height:650px;border:1px solid #ccc"></iframe></body></html>`);
    });
    return { token };
  }

  async function capture(win, name) {
    const image = await win.capturePage();
    const file = path.join(screenshotsDir, name);
    await fsp.writeFile(file, image.toPNG());
    proof("ui-screenshot", { file: name });
  }

  async function evaluate(win, script) {
    return win.webContents.executeJavaScript(script, true);
  }

  async function buttonCenter(win, matcher) {
    return evaluate(win, `(() => {
      const norm = value => String(value || '').replace(/\\s+/g,' ').trim();
      const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'; };
      const buttons=[...document.querySelectorAll('button')].filter(visible);
      const item=buttons.find(el => ${matcher}); if(!item) return null; const r=item.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:norm(item.innerText||item.textContent),title:item.getAttribute('title')||''};
    })()`);
  }

  async function clickButton(win, matcher, label) {
    const point = await waitFor(() => buttonCenter(win, matcher), 15_000, `button ${label}`);
    proof("ui-button-input", { label, point });
    win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await delay(35);
    win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  }

  async function clickText(win, text) {
    const quoted = JSON.stringify(text);
    return clickButton(win, `norm(el.innerText||el.textContent)===${quoted}`, text);
  }

  async function clickContains(win, text) {
    const quoted = JSON.stringify(text);
    return clickButton(win, `norm(el.innerText||el.textContent).includes(${quoted})`, text);
  }

  async function clickTitle(win, title) {
    const quoted = JSON.stringify(title);
    return clickButton(win, `String(el.getAttribute('title')||'')===${quoted}`, title);
  }

  async function setInputByPlaceholder(win, placeholder, value) {
    await waitFor(async () => {
      const ok = await evaluate(win, `(() => { const el=[...document.querySelectorAll('input')].find(x=>x.getAttribute('placeholder')===${JSON.stringify(placeholder)}); if(!el)return false; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
      return ok ? true : undefined;
    }, 10_000, `input ${placeholder}`);
  }

  async function rendererApi(win, expression) {
    return evaluate(win, `(async()=>{ if(!window.ares) throw new Error('window.ares missing'); return await (${expression}); })()`);
  }

  async function reloadAndWait(win) {
    const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    win.reload();
    await loaded;
    await waitFor(() => evaluate(win, `Boolean(window.ares && document.querySelector('app-root'))`), 15_000, "Angular UI reload");
    await delay(500);
  }

  function processSnapshot(label) {
    try {
      const command = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|python|node|electron' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
      const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 12_000, windowsHide: true }).trim();
      const value = raw ? JSON.parse(raw) : [];
      fs.writeFileSync(path.join(proofRoot, `processes-${label}.json`), JSON.stringify(value, null, 2), "utf8");
      proof("process-snapshot", { label, count: Array.isArray(value) ? value.length : 1 });
    } catch (error) {
      proof("process-snapshot-error", { label, error: String(error?.message || error) });
    }
  }

  async function findNamedFile(root, name) {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isFile() && entry.name === name) return candidate;
      if (entry.isDirectory()) {
        const nested = await findNamedFile(candidate, name);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  async function persistVisionCrops() {
    const call = visionCalls.find(item => Array.isArray(item.sources) && item.sources.length === 9);
    if (!call) throw new Error("Vision service never received 9 screenshot crops.");
    for (let index = 0; index < call.sources.length; index += 1) {
      const match = String(call.sources[index]).match(/^data:image\/png;base64,(.+)$/);
      if (!match) throw new Error(`Vision crop ${index} is not PNG data URI.`);
      await fsp.writeFile(path.join(cropsDir, `tile-${String(index + 1).padStart(2, "0")}.png`), Buffer.from(match[1], "base64"));
    }
    await fsp.writeFile(path.join(proofRoot, "vision.json"), JSON.stringify({ instruction: call.instruction, tileCount: call.sources.length, selectedIndexes: EXPECTED }, null, 2));
    proof("vision-crops-persisted", { count: call.sources.length });
  }

  async function run(win) {
    proof("harness-start", { platform: process.platform, electron: process.versions.electron, node: process.versions.node, userData });
    if (process.platform !== "win32") throw new Error(`Windows UI E2E must run on win32, got ${process.platform}.`);
    processSnapshot("00-start");

    const { token } = createServers();
    const framePort = await listen(frameServer, "localhost");
    const mainPort = await listen(mainServer, "127.0.0.1");
    const visionPort = await listen(visionServer, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${mainPort}/`;
    process.env.ARES_VISION_SERVICE_URL = `http://127.0.0.1:${visionPort}`;
    process.env.ARES_VISION_SERVICE_TOKEN = token;
    process.env.ARES_VISION_OFFLINE = "1";
    proof("fixture-ready", { baseUrl, framePort, visionPort });

    await waitFor(() => evaluate(win, `Boolean(window.ares && document.querySelector('app-root'))`), 20_000, "Angular UI + preload");
    await capture(win, "01-ui-loaded.png");

    const profile = {
      id: PROFILE_ID,
      name: PROFILE_NAME,
      contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
      address: { address1: "Teststrasse 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
      browser: { headless: false, kiAutofill: true }
    };
    const saveProfile = await rendererApi(win, `window.ares.saveProfile(${JSON.stringify(profile)})`);
    if (!saveProfile?.success) throw new Error(`saveProfile failed: ${saveProfile?.error || "unknown"}`);
    const registerShop = await rendererApi(win, `window.ares.registerShop(${JSON.stringify({ id: SHOP_ID, name: "Windows UI Runtime E2E", baseUrl, platform: "custom", config: {} })})`);
    if (!registerShop?.success) throw new Error(`registerShop failed: ${registerShop?.error || "unknown"}`);
    const taskConfig = {
      id: TASK_ID,
      name: "Windows UI Runtime OOPIF E2E",
      shopId: SHOP_ID,
      maxRetries: 0,
      data: {
        profileId: PROFILE_ID,
        proxySelection: { mode: "direct" },
        browserConfig: { headless: false, args: ["--site-per-process", "--window-size=1280,900", "--force-device-scale-factor=1"] },
        monitorStrategy: { mode: "early-gate", productName: "Exam Fixture", discoveryKeywords: ["exam", "fixture"] },
        monitorAction: { mode: "auto-checkout", profileId: PROFILE_ID, headless: false, proxySelection: { mode: "direct" } }
      }
    };
    const createTask = await rendererApi(win, `window.ares.createTask(${JSON.stringify(taskConfig)})`);
    if (!createTask?.success) throw new Error(`createTask failed: ${createTask?.error || "unknown"}`);
    proof("setup-via-preload-ipc", { profileId: PROFILE_ID, shopId: SHOP_ID, taskId: TASK_ID, headless: false });
    await reloadAndWait(win);

    await clickContains(win, "Profiles");
    await delay(350);
    await clickContains(win, PROFILE_NAME);
    await clickText(win, "Browser");
    await waitFor(() => buttonCenter(win, `norm(el.innerText||el.textContent)==='Profilbrowser öffnen'`), 10_000, "profile browser button");
    await capture(win, "02-profiles-browser-tab.png");

    await clickText(win, "Profilbrowser öffnen");
    const normalOpen = await waitFor(async () => {
      const result = await rendererApi(win, `window.ares.getProfileBrowserStatus(${JSON.stringify(PROFILE_ID)})`);
      return result?.success && result.status?.open ? result.status : undefined;
    }, 35_000, "normal profile browser open");
    proof("profile-browser-opened-from-ui", { status: normalOpen });
    processSnapshot("01-profile-browser-open");
    await capture(win, "03-profile-browser-open.png");
    await clickText(win, "Profilbrowser schließen");
    await waitFor(async () => {
      const result = await rendererApi(win, `window.ares.getProfileBrowserStatus(${JSON.stringify(PROFILE_ID)})`);
      return result?.success && !result.status?.open ? true : undefined;
    }, 25_000, "normal profile browser close");
    proof("profile-browser-closed-from-ui");

    await setInputByPlaceholder(win, "https://shop.example/", baseUrl);
    await clickText(win, "SeleniumBase CDP öffnen");
    const cdpOpen = await waitFor(async () => {
      const result = await rendererApi(win, `window.ares.getSeleniumBaseProfileBrowserStatus(${JSON.stringify(PROFILE_ID)})`);
      return result?.success && result.status?.open ? result.status : undefined;
    }, 35_000, "SeleniumBase CDP profile browser open");
    proof("seleniumbase-profile-browser-opened-from-ui", { status: cdpOpen, headless: false });
    processSnapshot("02-seleniumbase-profile-open");
    await capture(win, "04-seleniumbase-cdp-open.png");
    await clickText(win, "CDP sauber schließen");
    await waitFor(async () => {
      const result = await rendererApi(win, `window.ares.getSeleniumBaseProfileBrowserStatus(${JSON.stringify(PROFILE_ID)})`);
      return result?.success && !result.status?.open ? true : undefined;
    }, 25_000, "SeleniumBase CDP profile browser close");
    proof("seleniumbase-profile-browser-closed-from-ui");

    await clickContains(win, "Tasks");
    await waitFor(() => evaluate(win, `document.body.innerText.includes(${JSON.stringify("Windows UI Runtime OOPIF E2E")})`), 10_000, "task row");
    await capture(win, "05-task-ready.png");
    await clickTitle(win, "Start task");
    proof("task-start-clicked-from-ui", { taskId: TASK_ID, expectedChain: ["Angular UI", "preload IPC", "Electron main", "TaskOrchestrator", "BrowserWorkerPoolClient", "node worker.js", "Python OOPIF child", "SeleniumBase CDP"] });

    await waitFor(() => hits.find(hit => hit.type === "frame-loaded"), 55_000, "cross-site OOPIF frame load");
    processSnapshot("03-task-runtime");
    const solved = await waitFor(async () => {
      const failed = hits.find(hit => hit.type === "failed");
      if (failed) throw new Error(`fixture failed selected=${failed.selected}`);
      const status = await rendererApi(win, `window.ares.getTaskStatus(${JSON.stringify(TASK_ID)})`);
      if (status?.task?.lastError) throw new Error(status.task.lastError);
      return hits.find(hit => hit.type === "solved");
    }, 90_000, "automatic OOPIF grid solve", 250);
    if (solved.trusted !== "true") throw new Error("Grid/submit events were not trusted.");
    if (solved.selected !== EXPECTED.join(",")) throw new Error(`Wrong selection ${solved.selected}.`);
    if (Number(solved.clicks) < 4) throw new Error(`Expected >=4 trusted clicks, got ${solved.clicks}.`);
    await persistVisionCrops();
    await capture(win, "06-task-solved-ui.png");

    const status = await rendererApi(win, `window.ares.getTaskStatus(${JSON.stringify(TASK_ID)})`);
    proof("task-status-after-solve", { state: status?.status, browserSession: status?.task?.config?.data?.browserSession, browserWorker: status?.task?.config?.data?.browserWorker });

    const tracePath = await findNamedFile(path.join(userData, "browser-profiles"), ".ares-visual-trace.jsonl");
    if (!tracePath) throw new Error(".ares-visual-trace.jsonl not found under real Electron userData/browser-profiles.");
    const trace = await fsp.readFile(tracePath, "utf8");
    const required = [
      '"origin":"direct-children"',
      '"tileCount":9',
      '"selectedIndexes":[1,4,7]',
      '"phase":"cursor-click"',
      '"seeded":true',
      '"provider":"python-bezier:cdp"',
      '"verified":true'
    ];
    for (const token of required) if (!trace.includes(token)) throw new Error(`Visual trace missing ${token}`);
    if (!/"scope":"oopif:/.test(trace)) throw new Error("Visual trace missing OOPIF scope.");
    await fsp.copyFile(tracePath, path.join(traceOut, "ares-visual-trace.jsonl"));
    proof("visual-trace-verified", { source: tracePath, tokens: required, oopif: true });

    const system = await rendererApi(win, `window.ares.getSystemStatus()`);
    await fsp.writeFile(path.join(proofRoot, "system-status.json"), JSON.stringify(system, null, 2));
    proof("system-status", { browserWorkerPool: system?.browserWorkerPool });
    processSnapshot("04-before-app-shutdown");
    await capture(win, "07-final-proof.png");
    proof("e2e-pass", { trusted: solved.trusted, selected: solved.selected, clicks: solved.clicks, visionCalls: visionCalls.length, headless: false });
  }

  async function finish(code, error) {
    if (finished) return;
    finished = true;
    if (error) {
      proof("e2e-fail", { error: String(error?.stack || error?.message || error) });
      process.exitCode = code || 1;
    }
    await Promise.allSettled([closeServer(mainServer), closeServer(frameServer), closeServer(visionServer)]);
    proof("servers-closed");
    app.quit();
  }

  app.on("browser-window-created", (_event, win) => {
    win.webContents.once("did-finish-load", () => {
      void run(win).then(() => finish(0)).catch(error => finish(1, error));
    });
  });

  process.on("uncaughtException", error => void finish(1, error));
  process.on("unhandledRejection", error => void finish(1, error));
}
