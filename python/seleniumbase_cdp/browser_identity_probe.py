from __future__ import annotations

import json
import os
import platform
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict
from urllib.parse import parse_qs, urlencode, urlsplit

from seleniumbase_adapter import SeleniumBaseCdpAdapter

SEEDS = (101, 202, 303)
ARTIFACT_ENV = "ARES_BROWSER_IDENTITY_ARTIFACT"
DEFAULT_ARTIFACT = Path("artifacts/browser-identity/ares-browser-identity.json")
HEADER_ALLOWLIST = (
    "user-agent",
    "accept-language",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-ch-ua-arch",
    "sec-ch-ua-bitness",
    "sec-ch-ua-full-version",
    "sec-ch-ua-full-version-list",
    "sec-ch-ua-platform-version",
)


class ProbeServer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: Dict[str, Dict[str, str]] = {}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query)
                token = str((query.get("token") or [""])[0])
                if token:
                    allowed: Dict[str, str] = {}
                    for name in HEADER_ALLOWLIST:
                        value = self.headers.get(name)
                        if value is not None:
                            allowed[name] = str(value)
                    with owner._lock:
                        owner._requests[token] = allowed

                body = (
                    "<!doctype html><meta charset='utf-8'>"
                    "<title>ARES Browser Identity Probe</title>"
                    "<body><main id='probe'>browser-identity-probe</main></body>"
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header(
                    "Accept-CH",
                    ", ".join(
                        (
                            "Sec-CH-UA-Arch",
                            "Sec-CH-UA-Bitness",
                            "Sec-CH-UA-Full-Version",
                            "Sec-CH-UA-Full-Version-List",
                            "Sec-CH-UA-Platform-Version",
                        )
                    ),
                )
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: Any) -> None:
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=self.httpd.serve_forever,
            name="ares-browser-identity-http",
            daemon=True,
        )

    @property
    def base_url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> None:
        self.thread.start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3.0)

    def headers_for(self, token: str) -> Dict[str, str]:
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            with self._lock:
                value = self._requests.get(token)
                if value is not None:
                    return dict(value)
            time.sleep(0.05)
        return {}


COLLECT_SCRIPT = r"""
const seed = Number(arguments[0]) >>> 0;

function seededRandom(initial) {
  let state = (initial >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashText(value) {
  const text = String(value ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function hashBytes(bytes) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= Number(bytes[i]) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function canvasProbe() {
  const random = seededRandom(seed ^ 0x13579bdf);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 120;
  const ctx = canvas.getContext('2d');
  if (!ctx) return {available:false, hash:null};
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 10; i += 1) {
    const r = Math.floor(random() * 255);
    const g = Math.floor(random() * 255);
    const b = Math.floor(random() * 255);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.globalAlpha = 0.25 + random() * 0.7;
    ctx.fillRect(random() * 280, random() * 90, 10 + random() * 60, 8 + random() * 35);
  }
  ctx.globalAlpha = 1;
  ctx.font = `${13 + (seed % 7)}px "Segoe UI", Arial, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#111';
  ctx.fillText(`ARES-${seed}-Ω-Canvas`, 9.25, 106.75);
  return {
    available: true,
    hash: hashText(canvas.toDataURL('image/png')),
    width: canvas.width,
    height: canvas.height,
  };
}

function webglProbe() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const gl = canvas.getContext('webgl2', {preserveDrawingBuffer:true})
    || canvas.getContext('webgl', {preserveDrawingBuffer:true});
  if (!gl) return {available:false};

  const random = seededRandom(seed ^ 0x2468ace0);
  gl.viewport(0, 0, 64, 64);
  gl.disable(gl.DITHER);
  gl.clearColor(random(), random(), random(), 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST);
  for (let i = 0; i < 5; i += 1) {
    gl.scissor(
      Math.floor(random() * 48),
      Math.floor(random() * 48),
      8 + Math.floor(random() * 24),
      8 + Math.floor(random() * 24)
    );
    gl.clearColor(random(), random(), random(), 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.disable(gl.SCISSOR_TEST);

  const pixels = new Uint8Array(64 * 64 * 4);
  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = String(gl.getParameter(gl.VENDOR) ?? '');
  const renderer = String(gl.getParameter(gl.RENDERER) ?? '');
  const unmaskedVendor = debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? '') : '';
  const unmaskedRenderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? '') : '';
  const caps = {
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0),
    maxRenderbufferSize: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 0),
    maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
  };
  const extensions = (gl.getSupportedExtensions() || []).slice().sort();
  return {
    available: true,
    version: String(gl.getParameter(gl.VERSION) ?? ''),
    shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) ?? ''),
    vendor,
    renderer,
    unmaskedVendor,
    unmaskedRenderer,
    caps,
    extensionsHash: hashText(JSON.stringify(extensions)),
    pixelHash: hashBytes(pixels),
  };
}

function fontsProbe() {
  const random = seededRandom(seed ^ 0x55aa55aa);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return {available:false, hash:null};
  const fonts = ['Arial', 'Times New Roman', 'Courier New', 'Segoe UI', 'Consolas'];
  const samples = [
    'ARES fingerprint metrics 0123456789',
    'Sphinx of black quartz, judge my vow',
    'Pack my box with five dozen liquor jugs',
  ];
  const sample = samples[seed % samples.length];
  const metrics = [];
  for (const font of fonts) {
    ctx.font = `${13 + Math.floor(random() * 6)}px "${font}", monospace`;
    const m = ctx.measureText(sample);
    metrics.push({
      font,
      width: Number(m.width.toFixed(4)),
      left: Number((m.actualBoundingBoxLeft || 0).toFixed(4)),
      right: Number((m.actualBoundingBoxRight || 0).toFixed(4)),
      ascent: Number((m.actualBoundingBoxAscent || 0).toFixed(4)),
      descent: Number((m.actualBoundingBoxDescent || 0).toFixed(4)),
    });
  }
  return {available:true, hash:hashText(JSON.stringify(metrics)), metrics};
}

function rectsProbe() {
  const random = seededRandom(seed ^ 0xa5a5a5a5);
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = '480px';
  host.style.contain = 'layout style paint';
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const node = document.createElement('span');
    node.textContent = `ARES-${seed}-${i}-rect`;
    node.style.display = 'inline-block';
    node.style.margin = `${(random() * 3).toFixed(3)}px`;
    node.style.padding = `${(random() * 4).toFixed(3)}px`;
    node.style.fontSize = `${(11 + random() * 9).toFixed(3)}px`;
    node.style.letterSpacing = `${(random() * 1.5).toFixed(3)}px`;
    node.style.transform = `translate(${(random() * 2).toFixed(3)}px, ${(random() * 2).toFixed(3)}px)`;
    host.appendChild(node);
    rows.push(node);
  }
  document.body.appendChild(host);
  const rects = rows.map((node) => {
    const rect = node.getBoundingClientRect();
    return {
      x: Number(rect.x.toFixed(4)),
      y: Number(rect.y.toFixed(4)),
      width: Number(rect.width.toFixed(4)),
      height: Number(rect.height.toFixed(4)),
    };
  });
  host.remove();
  return {hash:hashText(JSON.stringify(rects)), rects};
}

function screenProbe() {
  return {
    width: Number(screen.width || 0),
    height: Number(screen.height || 0),
    availWidth: Number(screen.availWidth || 0),
    availHeight: Number(screen.availHeight || 0),
    colorDepth: Number(screen.colorDepth || 0),
    pixelDepth: Number(screen.pixelDepth || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 0),
  };
}

function featureProbe() {
  let localStorageAvailable = false;
  try {
    const key = '__ares_identity_probe__';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    localStorageAvailable = true;
  } catch (_) {}
  let webgl2 = false;
  try {
    const c = document.createElement('canvas');
    webgl2 = !!c.getContext('webgl2');
  } catch (_) {}
  return {
    canvas: !!document.createElement('canvas').getContext,
    webgl2,
    webgpu: !!navigator.gpu,
    webrtc: typeof RTCPeerConnection !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
    webAssembly: typeof WebAssembly !== 'undefined',
    localStorage: localStorageAvailable,
  };
}

window.__aresIdentityResult = null;
window.__aresIdentityError = null;
(async () => {
  try {
    let uaData = null;
    if (navigator.userAgentData) {
      const base = {
        brands: Array.from(navigator.userAgentData.brands || []),
        mobile: !!navigator.userAgentData.mobile,
        platform: String(navigator.userAgentData.platform || ''),
      };
      try {
        const high = await navigator.userAgentData.getHighEntropyValues([
          'architecture',
          'bitness',
          'formFactors',
          'fullVersionList',
          'model',
          'platformVersion',
          'uaFullVersion',
          'wow64',
        ]);
        uaData = {...base, ...high};
      } catch (error) {
        uaData = {...base, highEntropyError:String(error)};
      }
    }
    window.__aresIdentityResult = {
      seed,
      readyState: String(document.readyState || ''),
      js: {
        userAgent: String(navigator.userAgent || ''),
        platform: String(navigator.platform || ''),
        language: String(navigator.language || ''),
        languages: Array.from(navigator.languages || []),
        hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
        deviceMemory: Number(navigator.deviceMemory || 0),
        maxTouchPoints: Number(navigator.maxTouchPoints || 0),
        cookieEnabled: !!navigator.cookieEnabled,
        pdfViewerEnabled: 'pdfViewerEnabled' in navigator ? !!navigator.pdfViewerEnabled : null,
        webdriver: 'webdriver' in navigator ? navigator.webdriver : null,
        plugins: Array.from(navigator.plugins || []).map((plugin) => String(plugin.name || '')).sort(),
        uaData,
      },
      intl: {
        timezone: String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''),
        locale: String(Intl.DateTimeFormat().resolvedOptions().locale || ''),
      },
      screen: screenProbe(),
      canvas: canvasProbe(),
      webgl: webglProbe(),
      fonts: fontsProbe(),
      rects: rectsProbe(),
      features: featureProbe(),
    };
  } catch (error) {
    window.__aresIdentityError = String(error && (error.stack || error.message) || error);
  }
})();
return true;
"""


def _strip_quotes(value: str) -> str:
    text = str(value or "").strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return text[1:-1]
    return text


def _normal_language(value: str) -> str:
    return str(value or "").strip().lower().replace("_", "-")


def _stable_projection(measurement: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "http": measurement.get("http") or {},
        "js": measurement.get("js") or {},
        "intl": measurement.get("intl") or {},
        "screen": measurement.get("screen") or {},
        "canvas": measurement.get("canvas") or {},
        "webgl": measurement.get("webgl") or {},
        "fonts": measurement.get("fonts") or {},
        "rects": measurement.get("rects") or {},
        "features": measurement.get("features") or {},
    }


def _append_check(
    checks: list[Dict[str, Any]],
    name: str,
    status: str,
    detail: str,
    *,
    seed: int | None = None,
) -> None:
    item: Dict[str, Any] = {"name": name, "status": status, "detail": detail}
    if seed is not None:
        item["seed"] = int(seed)
    checks.append(item)


def _collect_measurement(
    adapter: SeleniumBaseCdpAdapter,
    server: ProbeServer,
    *,
    run_index: int,
    seed: int,
) -> Dict[str, Any]:
    token = f"r{run_index}-s{seed}-{time.time_ns()}"
    prime_url = f"{server.base_url}/prime?{urlencode({'seed': seed})}"
    probe_url = f"{server.base_url}/probe?{urlencode({'seed': seed, 'token': token})}"
    adapter.goto(prime_url)
    adapter.goto(probe_url)
    adapter.execute_script(COLLECT_SCRIPT, int(seed))

    deadline = time.monotonic() + 8.0
    payload: Dict[str, Any] | None = None
    last_error = ""
    while time.monotonic() < deadline:
        try:
            error = adapter.execute_script("return window.__aresIdentityError || '';")
            if error:
                last_error = str(error)
                break
            result = adapter.execute_script("return window.__aresIdentityResult;")
            if isinstance(result, dict):
                payload = dict(result)
                break
        except Exception as exc:
            last_error = str(exc)
        time.sleep(0.1)

    if payload is None:
        raise RuntimeError(f"identity collector timed out for seed {seed}: {last_error or 'no result'}")
    payload["http"] = server.headers_for(token)
    payload["url"] = probe_url.split("?", 1)[0]
    payload["run"] = int(run_index)
    return payload


def _run_browser_pass(server: ProbeServer, *, run_index: int, profile_root: Path) -> Dict[str, Any]:
    profile_dir = profile_root / f"run-{run_index}"
    profile_dir.mkdir(parents=True, exist_ok=True)
    adapter = SeleniumBaseCdpAdapter(profile_dir=profile_dir, headless=False)
    try:
        measurements = [
            _collect_measurement(adapter, server, run_index=run_index, seed=seed)
            for seed in SEEDS
        ]
        return {
            "run": int(run_index),
            "measurements": measurements,
            "runtime": {
                "chromePidObserved": bool(adapter.chrome_pid),
                "metadataKeys": sorted(adapter.runtime_metadata().keys()),
            },
        }
    finally:
        adapter.quit()


def _evaluate(runs: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    checks: list[Dict[str, Any]] = []
    by_run: Dict[int, Dict[int, Dict[str, Any]]] = {}
    for run in runs:
        run_index = int(run["run"])
        by_run[run_index] = {int(item["seed"]): item for item in run.get("measurements") or []}

    if set(by_run) != {1, 2}:
        _append_check(checks, "two-browser-restarts", "FAIL", f"observed runs={sorted(by_run)}")
        return checks
    _append_check(
        checks,
        "two-browser-restarts",
        "PASS",
        "two independent headed sb_cdp browser starts completed",
    )

    for seed in SEEDS:
        first = by_run[1].get(seed)
        second = by_run[2].get(seed)
        if first is None or second is None:
            _append_check(checks, "same-seed-restart-stability", "FAIL", "measurement missing", seed=seed)
            continue

        first_projection = _stable_projection(first)
        second_projection = _stable_projection(second)
        if first_projection == second_projection:
            _append_check(
                checks,
                "same-seed-restart-stability",
                "PASS",
                "HTTP/JS/rendering projection identical across fresh browser profiles",
                seed=seed,
            )
        else:
            changed = [
                key for key in first_projection if first_projection.get(key) != second_projection.get(key)
            ]
            _append_check(
                checks,
                "same-seed-restart-stability",
                "FAIL",
                f"changed sections across restart: {changed}",
                seed=seed,
            )

        for run_index, item in ((1, first), (2, second)):
            http = item.get("http") or {}
            js = item.get("js") or {}
            http_ua = str(http.get("user-agent") or "")
            js_ua = str(js.get("userAgent") or "")
            if http_ua and js_ua and http_ua == js_ua:
                _append_check(
                    checks,
                    f"http-js-user-agent-r{run_index}",
                    "PASS",
                    "HTTP User-Agent equals navigator.userAgent",
                    seed=seed,
                )
            else:
                _append_check(
                    checks,
                    f"http-js-user-agent-r{run_index}",
                    "FAIL",
                    "HTTP User-Agent and navigator.userAgent differ or are missing",
                    seed=seed,
                )

            accept_language = _normal_language(str(http.get("accept-language") or "").split(",", 1)[0])
            js_language = _normal_language(str(js.get("language") or ""))
            if accept_language and js_language and (
                accept_language == js_language
                or accept_language.startswith(js_language + "-")
                or js_language.startswith(accept_language + "-")
            ):
                _append_check(
                    checks,
                    f"http-js-language-r{run_index}",
                    "PASS",
                    f"Accept-Language {accept_language!r} aligns with navigator.language {js_language!r}",
                    seed=seed,
                )
            else:
                _append_check(
                    checks,
                    f"http-js-language-r{run_index}",
                    "WARN",
                    f"language alignment not proven: HTTP={accept_language!r} JS={js_language!r}",
                    seed=seed,
                )

            ua_data = js.get("uaData") if isinstance(js.get("uaData"), dict) else None
            http_platform = _strip_quotes(str(http.get("sec-ch-ua-platform") or ""))
            js_platform = str((ua_data or {}).get("platform") or "")
            if http_platform and js_platform:
                status = "PASS" if http_platform == js_platform else "FAIL"
                _append_check(
                    checks,
                    f"http-js-client-hints-platform-r{run_index}",
                    status,
                    f"HTTP Sec-CH-UA-Platform={http_platform!r}, JS userAgentData.platform={js_platform!r}",
                    seed=seed,
                )
            else:
                _append_check(
                    checks,
                    f"http-js-client-hints-platform-r{run_index}",
                    "WARN",
                    "Client-Hints platform was not observable on the local HTTP origin",
                    seed=seed,
                )

    for run_index in (1, 2):
        items = by_run[run_index]
        for field_path, label in (
            (("canvas", "hash"), "canvas"),
            (("webgl", "pixelHash"), "webgl"),
            (("fonts", "hash"), "fonts"),
            (("rects", "hash"), "clientrects"),
        ):
            values = []
            for seed in SEEDS:
                item: Any = items.get(seed) or {}
                for key in field_path:
                    item = item.get(key) if isinstance(item, dict) else None
                values.append(item)
            if all(values) and len(set(values)) == len(SEEDS):
                _append_check(
                    checks,
                    f"seed-diversity-{label}-r{run_index}",
                    "PASS",
                    f"{label} produced {len(SEEDS)} distinct seeded measurement hashes",
                )
            else:
                _append_check(
                    checks,
                    f"seed-diversity-{label}-r{run_index}",
                    "FAIL",
                    f"{label} seeded hashes were missing or not distinct: {values}",
                )

    return checks


def _write_report(report: Dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def main() -> int:
    artifact = Path(os.environ.get(ARTIFACT_ENV) or DEFAULT_ARTIFACT)
    started_at = time.time()
    report: Dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "ares-browser-identity-proof",
        "head": os.environ.get("GITHUB_SHA") or "",
        "runner": {
            "os": platform.platform(),
            "python": sys.version.split()[0],
            "githubActions": os.environ.get("GITHUB_ACTIONS") == "true",
            "runnerName": os.environ.get("RUNNER_NAME") or "",
            "runnerEnvironment": os.environ.get("RUNNER_ENVIRONMENT") or "",
        },
        "seeds": list(SEEDS),
        "coverage": {
            "httpJsUserAgentParity": "TESTED",
            "clientHintsParity": "TESTED_WHEN_EXPOSED",
            "languageParity": "TESTED",
            "javascriptRuntime": "TESTED",
            "canvasSeededStability": "TESTED",
            "webglSeededStability": "TESTED",
            "fontMetricsSeededStability": "TESTED",
            "clientRectsSeededStability": "TESTED",
            "browserFeatureSurface": "RECORDED",
            "tlsJa3Ja4": "NOT_TESTED_LOCAL_ORIGIN",
            "http2Http3": "NOT_TESTED_LOCAL_ORIGIN",
            "publicIpIpv6Dns": "NOT_TESTED_LOCAL_ORIGIN",
            "webrtcAddressLeak": "NOT_TESTED_PRIVACY_SENSITIVE",
            "realGpuParity": "REQUIRES_SELF_HOSTED_RUNNER",
        },
        "runs": [],
        "checks": [],
    }

    server = ProbeServer()
    server.start()
    try:
        with tempfile.TemporaryDirectory(prefix="ares-browser-identity-") as temporary:
            root = Path(temporary)
            report["runs"].append(_run_browser_pass(server, run_index=1, profile_root=root))
            report["runs"].append(_run_browser_pass(server, run_index=2, profile_root=root))
        report["checks"] = _evaluate(report["runs"])
    except BaseException as exc:
        report["fatalError"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        server.close()
        report["durationMs"] = round((time.time() - started_at) * 1000.0, 3)
        statuses = [str(item.get("status") or "") for item in report.get("checks") or []]
        report["summary"] = {
            "pass": statuses.count("PASS"),
            "warn": statuses.count("WARN"),
            "fail": statuses.count("FAIL") + (1 if "fatalError" in report else 0),
        }
        _write_report(report, artifact)

    summary = report["summary"]
    print(
        "ARES_BROWSER_IDENTITY_PROOF "
        f"pass={summary['pass']} warn={summary['warn']} fail={summary['fail']} "
        f"artifact={artifact.as_posix()}",
        flush=True,
    )
    return 1 if int(summary["fail"]) > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
