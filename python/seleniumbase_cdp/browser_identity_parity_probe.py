from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List
from urllib.parse import parse_qs, urlencode, urlsplit

import psutil

DEFAULT_SEEDS = (101, 202, 303, 404)
DEFAULT_VIEWPORT = "1280,900"
DEFAULT_LANGUAGE = "en-US"
SAFE_HTTP_HEADERS = (
    "user-agent", "accept-language", "sec-ch-ua", "sec-ch-ua-mobile",
    "sec-ch-ua-platform", "sec-ch-ua-full-version-list",
    "sec-ch-ua-platform-version", "sec-ch-ua-arch", "sec-ch-ua-bitness",
    "sec-ch-ua-model", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
    "accept", "accept-encoding",
)
ACCEPT_CH = ", ".join((
    "Sec-CH-UA-Full-Version-List", "Sec-CH-UA-Platform-Version",
    "Sec-CH-UA-Arch", "Sec-CH-UA-Bitness", "Sec-CH-UA-Model",
))

TEST_PAGE = r'''<!doctype html>
<meta charset="utf-8"><title>ARES Browser Identity Parity Probe</title>
<style>html,body{margin:0;padding:0;font-family:Arial,sans-serif}#probe{width:941px;padding:17px}.rect{display:inline-block;margin:1.25px;padding:2.5px 5.75px;border:.5px solid #777}</style>
<div id="probe"></div>
<script>
(async()=>{
 const q=new URLSearchParams(location.search),seed=Number(q.get('seed')||0),runId=String(q.get('run_id')||''),lane=String(q.get('lane')||'');
 const canon=v=>Array.isArray(v)?v.map(canon):(v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v);
 const digest=async v=>{const s=typeof v==='string'?v:JSON.stringify(canon(v));const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return Array.from(new Uint8Array(h),b=>b.toString(16).padStart(2,'0')).join('')};
 let x=(seed>>>0)||1;const rng=()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296};
 const root=document.getElementById('probe');
 for(let i=0;i<24;i++){const s=document.createElement('span');s.className='rect';s.textContent=`seed-${seed}-cell-${i}-${Math.floor(rng()*100000)}`;s.style.fontSize=`${11+(i%7)}px`;s.style.letterSpacing=`${((i%5)-2)*.07}px`;root.appendChild(s)}
 const c=document.createElement('canvas');c.width=420;c.height=160;const cx=c.getContext('2d');cx.textBaseline='alphabetic';cx.font='19px Arial';cx.fillText(`ARES parity seed ${seed}`,12.25,32.75);cx.font="15px 'Times New Roman'";for(let i=0;i<9;i++)cx.fillText(String(Math.floor(rng()*1e8)),10+Math.floor(rng()*360)+.25,45+Math.floor(rng()*100)+.5);cx.beginPath();cx.arc(312.5,77.25,38.75,0,Math.PI*1.7);cx.stroke();const canvasHash=await digest(c.toDataURL());
 const gc=document.createElement('canvas'),gl=gc.getContext('webgl')||gc.getContext('experimental-webgl');let webgl={available:false};
 if(gl){const d=gl.getExtension('WEBGL_debug_renderer_info');webgl={available:true,vendor:String(gl.getParameter(gl.VENDOR)||''),renderer:String(gl.getParameter(gl.RENDERER)||''),unmaskedVendor:d?String(gl.getParameter(d.UNMASKED_VENDOR_WEBGL)||''):null,unmaskedRenderer:d?String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)||''):null,version:String(gl.getParameter(gl.VERSION)||''),shadingLanguageVersion:String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)||''),extensionsHash:await digest((gl.getSupportedExtensions()||[]).slice().sort())}}
 const fontNames=['Arial','Calibri','Cambria','Consolas','Courier New','Georgia','Segoe UI','Tahoma','Times New Roman','Trebuchet MS','Verdana'],fonts={};if(document.fonts&&document.fonts.check)for(const f of fontNames)fonts[f]=document.fonts.check(`16px "${f}"`);
 const rects=Array.from(document.querySelectorAll('.rect')).map(e=>{const r=e.getBoundingClientRect();return[+r.x.toFixed(3),+r.y.toFixed(3),+r.width.toFixed(3),+r.height.toFixed(3)]});
 const fn=['BarcodeDetector','Bluetooth','EyeDropper','GPU','IdleDetector','MediaCapabilities','OTPCredential','PaymentRequest','PresentationRequest','PublicKeyCredential','Sanitizer','SharedWorker','USB','VideoDecoder','VideoEncoder','WebSocket','Worker'],features={};for(const n of fn)features[n]=typeof globalThis[n]!=='undefined';features.serviceWorker=!!navigator.serviceWorker;features.webgl=!!gl;features.webgpu=!!navigator.gpu;features.localStorage=(()=>{try{return!!localStorage}catch{return false}})();
 let clientHints=null;if(navigator.userAgentData){clientHints={brands:(navigator.userAgentData.brands||[]).map(z=>({brand:String(z.brand),version:String(z.version)})).sort((a,b)=>`${a.brand}/${a.version}`.localeCompare(`${b.brand}/${b.version}`)),mobile:!!navigator.userAgentData.mobile,platform:String(navigator.userAgentData.platform||'')};try{const h=await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64']);clientHints.highEntropy=canon(h);if(Array.isArray(clientHints.highEntropy.fullVersionList))clientHints.highEntropy.fullVersionList=clientHints.highEntropy.fullVersionList.map(z=>({brand:String(z.brand),version:String(z.version)})).sort((a,b)=>`${a.brand}/${a.version}`.localeCompare(`${b.brand}/${b.version}`))}catch(e){clientHints.highEntropyError=String(e&&e.name||'error')}}
 const webrtc={supported:typeof RTCPeerConnection!=='undefined',candidateTypes:[],protocols:[],addressClasses:[]};if(webrtc.supported){try{const pc=new RTCPeerConnection({iceServers:[]});pc.createDataChannel('probe');const done=new Promise(resolve=>{const t=setTimeout(resolve,1600);pc.onicecandidate=e=>{if(!e.candidate){clearTimeout(t);resolve();return}const c=e.candidate;if(c.type)webrtc.candidateTypes.push(String(c.type));if(c.protocol)webrtc.protocols.push(String(c.protocol));const a=String(c.address||'');if(/^[0-9a-f:]+$/i.test(a)&&a.includes(':'))webrtc.addressClasses.push('ipv6');else if(/^\d+\.\d+\.\d+\.\d+$/.test(a))webrtc.addressClasses.push('ipv4');else if(a)webrtc.addressClasses.push('hostname-or-mdns')}});await pc.setLocalDescription(await pc.createOffer());await done;pc.close()}catch(e){webrtc.error=String(e&&e.name||'error')}}webrtc.candidateTypes=[...new Set(webrtc.candidateTypes)].sort();webrtc.protocols=[...new Set(webrtc.protocols)].sort();webrtc.addressClasses=[...new Set(webrtc.addressClasses)].sort();
 const payload={runId,lane,seed,javascript:{userAgent:navigator.userAgent,webdriver:navigator.webdriver,platform:navigator.platform,languages:Array.from(navigator.languages||[]),language:navigator.language,hardwareConcurrency:navigator.hardwareConcurrency??null,deviceMemory:navigator.deviceMemory??null,maxTouchPoints:navigator.maxTouchPoints??null,cookieEnabled:navigator.cookieEnabled,pdfViewerEnabled:navigator.pdfViewerEnabled??null},clientHints,timezone:{resolved:Intl.DateTimeFormat().resolvedOptions().timeZone,offsetMinutes:new Date().getTimezoneOffset(),locale:Intl.DateTimeFormat().resolvedOptions().locale},screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,colorDepth:screen.colorDepth,pixelDepth:screen.pixelDepth,devicePixelRatio:devicePixelRatio,innerWidth,innerHeight,outerWidth,outerHeight},canvas:{hash:canvasHash},webgl,fonts,clientRects:{hash:await digest(rects),count:rects.length},features:{values:features,hash:await digest(features)},webrtc};
 await fetch(`/collect?${new URLSearchParams({run_id:runId,lane,seed:String(seed)})}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});document.title='ARES_IDENTITY_CAPTURED';
})().catch(async e=>{try{const q=new URLSearchParams(location.search);await fetch(`/collect?${new URLSearchParams({run_id:String(q.get('run_id')||''),lane:String(q.get('lane')||''),seed:String(q.get('seed')||0),error:'1'})}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:String(e&&(e.stack||e.message)||e)})})}catch{}});
</script>'''


def _canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    return value


def _safe_headers(headers: Any) -> Dict[str, str]:
    lowered = {str(key).lower(): str(value) for key, value in headers.items()}
    return {name: lowered[name] for name in SAFE_HTTP_HEADERS if name in lowered}


class CollectorState:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._captures: Dict[str, Dict[str, Any]] = {}

    def record(self, run_id: str, lane: str, seed: int, payload: Dict[str, Any], headers: Dict[str, str]) -> None:
        with self._condition:
            self._captures[run_id] = {"lane": lane, "seed": seed, "javascript": payload, "http": {"headers": headers}}
            self._condition.notify_all()

    def wait(self, run_ids: Iterable[str], timeout: float) -> Dict[str, Dict[str, Any]]:
        wanted = set(run_ids)
        deadline = time.monotonic() + timeout
        with self._condition:
            while True:
                ready = {key: value for key, value in self._captures.items() if key in wanted}
                if wanted.issubset(ready):
                    return ready
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return ready
                self._condition.wait(min(remaining, 0.5))


def _handler_factory(state: CollectorState):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ARESIdentityProbe/1.0"
        def log_message(self, fmt: str, *args: Any) -> None:
            return
        def _headers(self, content_type: str) -> None:
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Accept-CH", ACCEPT_CH)
        def do_GET(self) -> None:
            if urlsplit(self.path).path not in {"/", "/index.html"}:
                self.send_response(404); self.end_headers(); return
            body = TEST_PAGE.encode("utf-8")
            self.send_response(200); self._headers("text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        def do_POST(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path != "/collect":
                self.send_response(404); self.end_headers(); return
            query = parse_qs(parsed.query); run_id = str((query.get("run_id") or [""])[0]); lane = str((query.get("lane") or [""])[0])
            try: seed = int((query.get("seed") or ["0"])[0])
            except ValueError: seed = 0
            try: length = min(int(self.headers.get("Content-Length") or "0"), 1_000_000)
            except ValueError: length = 0
            try: payload = json.loads(self.rfile.read(max(0, length)).decode("utf-8"))
            except Exception: payload = {"error": "invalid-json"}
            if not isinstance(payload, dict): payload = {"error": "invalid-payload"}
            if run_id and lane in {"stock", "ares"}: state.record(run_id, lane, seed, payload, _safe_headers(self.headers))
            body = b'{"ok":true}'; self.send_response(200); self._headers("application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    return Handler


def _find_stock_chrome() -> Path:
    candidates: List[Path] = []
    for name in ("chrome.exe", "chrome"):
        resolved = shutil.which(name)
        if resolved: candidates.append(Path(resolved))
    for env_name, relative in (("PROGRAMFILES", r"Google\Chrome\Application\chrome.exe"), ("PROGRAMFILES(X86)", r"Google\Chrome\Application\chrome.exe"), ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe")):
        root = os.environ.get(env_name)
        if root: candidates.append(Path(root) / relative)
    for candidate in candidates:
        try:
            if candidate.is_file(): return candidate.resolve()
        except OSError: pass
    raise FileNotFoundError("Stock Google Chrome executable was not found on this Windows runner.")


def _profile_processes(profile_dir: Path) -> List[psutil.Process]:
    target = os.path.normcase(str(profile_dir.resolve())); result: List[psutil.Process] = []
    for process in psutil.process_iter(["pid", "cmdline"]):
        try: args = [str(value) for value in (process.info.get("cmdline") or [])]
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.Error): continue
        for index, arg in enumerate(args):
            value = arg.split("=", 1)[1] if arg.startswith("--user-data-dir=") else (args[index + 1] if arg == "--user-data-dir" and index + 1 < len(args) else "")
            if not value: continue
            try: normalized = os.path.normcase(str(Path(value.strip('"')).resolve()))
            except OSError: normalized = os.path.normcase(os.path.abspath(value.strip('"')))
            if normalized == target: result.append(process); break
    return result


def _stop_profile_processes(profile_dir: Path) -> None:
    processes = _profile_processes(profile_dir)
    for process in processes:
        try: process.terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.Error): pass
    _, alive = psutil.wait_procs(processes, timeout=3.0)
    for process in alive:
        try: process.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.Error): pass
    if alive: psutil.wait_procs(alive, timeout=2.0)


def _stock_args(chrome: Path, profile: Path, url: str, viewport: str, language: str) -> List[str]:
    return [str(chrome), f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", f"--window-size={viewport}", f"--lang={language}", "--new-window", url]


def _ares_child(args: argparse.Namespace) -> int:
    from seleniumbase_adapter import SeleniumBaseCdpAdapter
    adapter = SeleniumBaseCdpAdapter(profile_dir=Path(args.profile).resolve(), headless=False, language=args.language, browser_args=[f"--window-size={args.viewport}"])
    try:
        adapter.goto(args.url)
        # The local page collects and POSTs the fingerprint itself. ARES does not
        # read fingerprint values via CDP, keeping collection symmetric.
        time.sleep(float(args.child_hold_seconds))
        return 0
    finally:
        adapter.quit()


def _flatten(capture: Dict[str, Any]) -> Dict[str, Any]:
    payload = capture.get("javascript") if isinstance(capture.get("javascript"), dict) else {}
    headers = ((capture.get("http") or {}).get("headers") or {}) if isinstance(capture.get("http"), dict) else {}
    js = payload.get("javascript") if isinstance(payload.get("javascript"), dict) else {}
    screen = payload.get("screen") if isinstance(payload.get("screen"), dict) else {}
    timezone = payload.get("timezone") if isinstance(payload.get("timezone"), dict) else {}
    canvas = payload.get("canvas") if isinstance(payload.get("canvas"), dict) else {}
    webgl = payload.get("webgl") if isinstance(payload.get("webgl"), dict) else {}
    rects = payload.get("clientRects") if isinstance(payload.get("clientRects"), dict) else {}
    features = payload.get("features") if isinstance(payload.get("features"), dict) else {}
    return {
        "http.userAgent": headers.get("user-agent"), "http.acceptLanguage": headers.get("accept-language"),
        "http.clientHints": {k: v for k, v in headers.items() if k.startswith("sec-ch-ua")},
        "js.userAgent": js.get("userAgent"), "js.webdriver": js.get("webdriver"), "navigator.platform": js.get("platform"),
        "navigator.languages": js.get("languages"), "navigator.language": js.get("language"), "navigator.hardwareConcurrency": js.get("hardwareConcurrency"),
        "navigator.deviceMemory": js.get("deviceMemory"), "navigator.maxTouchPoints": js.get("maxTouchPoints"), "clientHints": payload.get("clientHints"),
        "timezone": timezone, "screen": screen, "canvas": canvas.get("hash"), "webgl.vendor": webgl.get("vendor"), "webgl.renderer": webgl.get("renderer"),
        "webgl.unmaskedVendor": webgl.get("unmaskedVendor"), "webgl.unmaskedRenderer": webgl.get("unmaskedRenderer"), "webgl.extensions": webgl.get("extensionsHash"),
        "fonts": payload.get("fonts"), "clientRects": rects.get("hash"), "features": features.get("hash"), "webrtc": payload.get("webrtc"),
    }


def _diff_pair(stock: Dict[str, Any], ares: Dict[str, Any]) -> Dict[str, Any]:
    left, right = _flatten(stock), _flatten(ares); result: Dict[str, Any] = {}
    for name in sorted(set(left) | set(right)):
        stock_value, ares_value = _canonical(left.get(name)), _canonical(right.get(name)); same = stock_value == ares_value
        result[name] = {"same": same, "stock": stock_value, "ares": ares_value, "classification": "same" if same else "lane-difference"}
    return result


def _cross_layer(capture: Dict[str, Any]) -> Dict[str, Any]:
    metrics = _flatten(capture); http_ua, js_ua = metrics.get("http.userAgent"), metrics.get("js.userAgent")
    http_lang = str(metrics.get("http.acceptLanguage") or "").split(",", 1)[0].strip().lower(); js_lang = str(metrics.get("navigator.language") or "").strip().lower()
    return {"httpUaMatchesJsUa": bool(http_ua) and bool(js_ua) and http_ua == js_ua, "httpLanguageMatchesJsLanguage": bool(http_lang) and bool(js_lang) and http_lang == js_lang, "clientHintsPresentInHttp": bool(metrics.get("http.clientHints")), "clientHintsPresentInJs": metrics.get("clientHints") is not None}


def _classify(pairs: List[Dict[str, Any]]) -> Dict[str, Any]:
    names = sorted({name for pair in pairs for name in pair["differences"]}); summary: Dict[str, Any] = {}
    for name in names:
        obs = [pair["differences"][name] for pair in pairs if name in pair["differences"]]; same = sum(1 for item in obs if item["same"]); diff = len(obs) - same
        classification = "unavailable" if not obs else ("no-observed-lane-difference" if diff == 0 else ("persistent-lane-difference" if same == 0 else "seed-sensitive-or-noise"))
        summary[name] = {"classification": classification, "sameCount": same, "diffCount": diff, "total": len(obs)}
    return summary


def _run(args: argparse.Namespace) -> int:
    if os.name != "nt": raise RuntimeError("Browser identity parity probe requires Windows for the Stock Chrome control lane.")
    chrome = _find_stock_chrome(); seeds = [int(v.strip()) for v in str(args.seeds).split(",") if v.strip()]
    if not seeds: raise ValueError("At least one seed is required.")
    state = CollectorState(); server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_factory(state)); thread = threading.Thread(target=server.serve_forever, name="ares-identity-http", daemon=True); thread.start(); port = int(server.server_address[1])
    output = Path(args.output).resolve(); output.parent.mkdir(parents=True, exist_ok=True); pairs: List[Dict[str, Any]] = []; failures: List[Dict[str, Any]] = []
    try:
        with tempfile.TemporaryDirectory(prefix="ares-identity-") as temp_root:
            root = Path(temp_root)
            for seed in seeds:
                token = uuid.uuid4().hex[:12]; stock_id = f"stock-{seed}-{token}"; ares_id = f"ares-{seed}-{token}"; stock_profile = root / stock_id; ares_profile = root / ares_id; stock_profile.mkdir(); ares_profile.mkdir()
                base = f"http://127.0.0.1:{port}/"; stock_url = base + "?" + urlencode({"run_id": stock_id, "lane": "stock", "seed": seed}); ares_url = base + "?" + urlencode({"run_id": ares_id, "lane": "ares", "seed": seed})
                stock_process = subprocess.Popen(_stock_args(chrome, stock_profile, stock_url, args.viewport, args.language), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                ares_process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--ares-child", "--profile", str(ares_profile), "--url", ares_url, "--viewport", args.viewport, "--language", args.language, "--child-hold-seconds", str(args.child_hold_seconds)])
                started = time.monotonic()
                try:
                    captures = state.wait((stock_id, ares_id), timeout=float(args.timeout_seconds)); stock_capture, ares_capture = captures.get(stock_id), captures.get(ares_id)
                    if stock_capture is None or ares_capture is None:
                        failures.append({"seed": seed, "stockCaptured": stock_capture is not None, "aresCaptured": ares_capture is not None, "elapsedMs": round((time.monotonic() - started) * 1000, 2)}); continue
                    pairs.append({"seed": seed, "environment": {"viewport": args.viewport, "language": args.language, "timezonePolicy": "shared-Windows-runner-system-timezone", "stockControl": "direct-chrome-process-no-cdp-no-webdriver", "aresLane": "seleniumbase-sb_cdp", "profiles": "fresh-clean-per-lane-per-seed"}, "stockCrossLayer": _cross_layer(stock_capture), "aresCrossLayer": _cross_layer(ares_capture), "differences": _diff_pair(stock_capture, ares_capture), "elapsedMs": round((time.monotonic() - started) * 1000, 2)})
                finally:
                    _stop_profile_processes(stock_profile)
                    if stock_process.poll() is None:
                        try: stock_process.terminate()
                        except OSError: pass
                    try: ares_process.wait(timeout=12.0)
                    except subprocess.TimeoutExpired:
                        ares_process.terminate()
                        try: ares_process.wait(timeout=4.0)
                        except subprocess.TimeoutExpired: ares_process.kill()
                    _stop_profile_processes(ares_profile)
        report = {"schema": "ares-browser-identity-parity/v1", "generatedAtUnix": time.time(), "controlIntegrity": {"stockChromeStartedDirectly": True, "stockChromeRemoteDebuggingEnabled": False, "stockChromeReadViaAutomation": False, "collection": "local-page-javascript-post-plus-server-side-http-headers", "rawCookiesStored": False, "rawWebRtcAddressesStored": False, "canvasImagesStored": False}, "environment": {"stockChromeExecutable": str(chrome), "seeds": seeds, "viewport": args.viewport, "language": args.language}, "pairs": pairs, "metricSummary": _classify(pairs), "failures": failures}
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        persistent = [name for name, item in report["metricSummary"].items() if item["classification"] == "persistent-lane-difference"]; noisy = [name for name, item in report["metricSummary"].items() if item["classification"] == "seed-sensitive-or-noise"]
        print(f"ARES_BROWSER_IDENTITY_PARITY pairs={len(pairs)}/{len(seeds)} persistentDiffs={len(persistent)} seedSensitive={len(noisy)} report={output}")
        if persistent: print("PERSISTENT_LANE_DIFFERENCES " + ",".join(persistent))
        if noisy: print("SEED_SENSITIVE_OR_NOISE " + ",".join(noisy))
        return 1 if failures or len(pairs) != len(seeds) else 0
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3.0)


def _self_test() -> int:
    stock = {"javascript": {"javascript": {"userAgent": "UA", "webdriver": False, "language": "en-US", "languages": ["en-US"]}, "canvas": {"hash": "abc"}, "webgl": {"vendor": "V", "renderer": "R"}, "screen": {"width": 1280}, "timezone": {"resolved": "UTC"}, "features": {"hash": "f"}, "clientRects": {"hash": "r"}, "fonts": {"Arial": True}, "webrtc": {"supported": True, "candidateTypes": ["host"]}}, "http": {"headers": {"user-agent": "UA", "accept-language": "en-US"}}}
    ares = json.loads(json.dumps(stock)); ares["javascript"]["canvas"]["hash"] = "xyz"; diff = _diff_pair(stock, ares)
    assert diff["js.userAgent"]["same"] is True and diff["canvas"]["same"] is False
    summary = _classify([{"differences": diff}, {"differences": diff}]); assert summary["canvas"]["classification"] == "persistent-lane-difference" and summary["js.userAgent"]["classification"] == "no-observed-lane-difference" and _cross_layer(stock)["httpUaMatchesJsUa"] is True
    print("browser_identity_parity_probe self-test: PASS"); return 0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(); parser.add_argument("--output", default="artifacts/browser-identity-parity/report.json"); parser.add_argument("--seeds", default=",".join(str(v) for v in DEFAULT_SEEDS)); parser.add_argument("--viewport", default=DEFAULT_VIEWPORT); parser.add_argument("--language", default=DEFAULT_LANGUAGE); parser.add_argument("--timeout-seconds", type=float, default=35.0); parser.add_argument("--child-hold-seconds", type=float, default=3.0); parser.add_argument("--self-test", action="store_true"); parser.add_argument("--ares-child", action="store_true"); parser.add_argument("--profile"); parser.add_argument("--url"); return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.self_test: return _self_test()
    if args.ares_child:
        if not args.profile or not args.url: raise SystemExit("--ares-child requires --profile and --url")
        return _ares_child(args)
    return _run(args)


if __name__ == "__main__":
    raise SystemExit(main())
