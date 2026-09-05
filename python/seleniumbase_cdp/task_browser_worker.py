from __future__ import annotations

import json
import queue
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

import mycdp
from seleniumbase_adapter import SeleniumBaseCdpAdapter

PREFIX = "ARES_SB_TASK\t"
MAX_RESPONSE_BODY = 256_000


def emit(payload: Dict[str, Any]) -> None:
    print(f"{PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def read_first() -> Dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("No SeleniumBase task start command received")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise TypeError("Start command must be a JSON object")
    return value


def command_reader(target: queue.Queue[Dict[str, Any]]) -> None:
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            value = json.loads(raw)
            if isinstance(value, dict):
                target.put(value)
        except Exception as exc:
            emit({"type": "error", "error": f"Invalid RPC JSON: {exc}"})


def as_proxy(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def pattern_payload(value: Any) -> Dict[str, str] | None:
    if isinstance(value, str):
        return {"source": re.escape(value), "flags": "i"}
    if isinstance(value, dict):
        return {"source": str(value.get("source") or ""), "flags": str(value.get("flags") or "")}
    return None


def locator_script() -> str:
    return r"""
const selector = String(arguments[0] || '');
const nth = Number(arguments[1] ?? -1);
const textSpec = arguments[2];
const action = String(arguments[3] || '');
const payload = arguments[4] || {};
const visible = el => {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
};
let items = Array.from(document.querySelectorAll(selector));
if (textSpec && textSpec.source !== undefined) {
  let rx;
  try { rx = new RegExp(String(textSpec.source || ''), String(textSpec.flags || '').replace(/g/g, '')); }
  catch (_) { rx = new RegExp(String(textSpec.source || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  items = items.filter(el => rx.test(String(el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || '')));
}
const selected = nth >= 0 ? (items[nth] ? [items[nth]] : []) : items;
const el = selected[0];
if (action === 'count') return items.length;
if (action === 'all-text-contents') return selected.map(node => String(node.textContent || ''));
if (!el) return { __aresMissing: true };
if (action === 'is-visible') return visible(el);
if (action === 'is-enabled') return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
if (action === 'input-value') return String(el.value ?? '');
if (action === 'inner-text') return String(el.innerText ?? el.textContent ?? '');
if (action === 'bounding-box') { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }
if (action === 'scroll-into-view') { el.scrollIntoView({block:'center',inline:'nearest'}); return true; }
if (action === 'focus') { el.focus({preventScroll:true}); return document.activeElement === el; }
if (action === 'click') { el.scrollIntoView({block:'center',inline:'nearest'}); el.click(); return true; }
if (action === 'fill') {
  const value = String(payload.value ?? '');
  el.scrollIntoView({block:'center',inline:'nearest'}); el.focus({preventScroll:true});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) descriptor.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  return {value:String(el.value ?? ''), verified:String(el.value ?? '') === value};
}
if (action === 'select-option') {
  const wanted = String(payload.value ?? ''), options = Array.from(el.options || []);
  const match = options.find(option => String(option.value) === wanted) || options.find(option => String(option.textContent || '').trim() === wanted);
  if (!match) return {selected:false};
  el.value = match.value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  return {selected:true,value:String(el.value ?? '')};
}
return null;
"""


class TaskRpcRuntime:
    def __init__(self, adapter: SeleniumBaseCdpAdapter) -> None:
        self.adapter = adapter
        self.sb = getattr(adapter, "_sb")
        self._network_lock = threading.Lock()
        self._network_events: List[Dict[str, Any]] = []
        self.sb.add_handler(mycdp.network.ResponseReceived, self._on_response)

    async def _on_response(self, event: mycdp.network.ResponseReceived) -> None:
        response = event.response
        headers = {str(key).lower(): str(value) for key, value in dict(response.headers or {}).items()}
        item: Dict[str, Any] = {
            "url": str(response.url or ""),
            "headers": headers,
            "mimeType": str(response.mime_type or ""),
            "requestId": event.request_id,
        }
        with self._network_lock:
            self._network_events.append(item)
            if len(self._network_events) > 500:
                del self._network_events[:-500]

    def navigate(self, command: Dict[str, Any]) -> Dict[str, Any]:
        url = str(command.get("url") or "").strip()
        if not url:
            raise ValueError("navigate requires url")
        self.adapter.goto(url)
        return {"url": str(self.sb.get_current_url() or url), "result": True}

    def network_events(self) -> Dict[str, Any]:
        with self._network_lock:
            items = self._network_events[:]
            self._network_events.clear()
        if not items:
            return {"events": [], "url": str(self.sb.get_current_url() or "")}

        tab = self.sb.get_active_tab()
        loop = self.sb.get_event_loop()
        output: List[Dict[str, Any]] = []
        for item in items:
            event = {"url": item["url"], "headers": item["headers"]}
            mime = str(item.get("mimeType") or "")
            if re.search(r"json|javascript|text|xml", mime, re.I):
                try:
                    body, is_base64 = loop.run_until_complete(tab.send(mycdp.network.get_response_body(item["requestId"])))
                    if not is_base64 and isinstance(body, str) and len(body) <= MAX_RESPONSE_BODY:
                        event["body"] = body
                except Exception:
                    pass
            output.append(event)
        return {"events": output, "url": str(self.sb.get_current_url() or "")}

    def rpc(self, command: Dict[str, Any]) -> Dict[str, Any]:
        action = str(command.get("action") or "")
        if action == "title": return {"result": str(self.sb.get_title() or ""), "url": str(self.sb.get_current_url() or "")}
        if action == "evaluate-page":
            result = self._evaluate_function(str(command.get("script") or ""), command.get("args") if isinstance(command.get("args"), list) else [])
            return {"result": result, "url": str(self.sb.get_current_url() or "")}
        if action == "wait-load-state":
            self._wait_ready(int(command.get("timeoutMs") or 15_000)); return {"result": True, "url": str(self.sb.get_current_url() or "")}
        if action == "bring-to-front":
            bring = getattr(self.sb, "bring_active_window_to_front", None)
            if callable(bring): bring()
            return {"result": True}
        if action in {"mouse-move", "mouse-click"}: return {"result": self._mouse(action, command)}
        locator = command.get("locator")
        if not isinstance(locator, dict): raise ValueError(f"RPC action {action!r} requires locator")
        frame_path = [str(value) for value in locator.get("framePath") or [] if str(value)]
        return {"result": self._in_frames(frame_path, lambda: self._locator_op(action, locator, command)), "url": str(self.sb.get_current_url() or "")}

    def _locator_op(self, action: str, locator: Dict[str, Any], command: Dict[str, Any]) -> Any:
        selector = str(locator.get("selector") or "")
        if not selector: raise ValueError("locator selector is empty")
        nth = int(locator.get("nth")) if isinstance(locator.get("nth"), (int, float)) else -1
        text_spec = pattern_payload(locator.get("hasText"))
        if action == "wait-for":
            deadline = time.monotonic() + max(0.25, float(command.get("timeoutMs") or 15_000) / 1000.0)
            state = str(command.get("state") or "visible")
            while time.monotonic() < deadline:
                probe = "is-visible" if state == "visible" else "count"
                value = self.adapter.execute_script(locator_script(), selector, nth, text_spec, probe, {})
                if (state == "visible" and value is True) or (state != "visible" and int(value or 0) > 0): return True
                time.sleep(0.05)
            raise TimeoutError(f"Locator wait timed out: {selector}")
        if action in {"evaluate-one", "evaluate-all"}:
            return self._locator_evaluate(selector, nth, text_spec, str(command.get("script") or ""), command.get("args") if isinstance(command.get("args"), list) else [], all_items=action == "evaluate-all")
        result = self.adapter.execute_script(locator_script(), selector, nth, text_spec, action, {"value": command.get("value"), "options": command.get("options") or {}})
        if isinstance(result, dict) and result.get("__aresMissing"):
            if action == "count": return 0
            if action in {"is-visible", "is-enabled"}: return False
            if action in {"input-value", "inner-text"}: return ""
            if action == "bounding-box": return None
            raise LookupError(f"No element matched locator: {selector}")
        if action == "fill" and isinstance(result, dict) and not bool(result.get("verified")): raise RuntimeError(f"fill readback verification failed for {selector}")
        return result

    def _locator_evaluate(self, selector: str, nth: int, text_spec: Dict[str, str] | None, function_source: str, args: List[Any], *, all_items: bool) -> Any:
        script = r"""
const selector=String(arguments[0]||''), nth=Number(arguments[1]??-1), spec=arguments[2], fnSource=String(arguments[3]||''), extra=Array.isArray(arguments[4])?arguments[4]:[];
let items=Array.from(document.querySelectorAll(selector));
if(spec&&spec.source!==undefined){const rx=new RegExp(String(spec.source||''),String(spec.flags||'').replace(/g/g,''));items=items.filter(el=>rx.test(String(el.innerText||el.textContent||el.getAttribute('value')||el.getAttribute('aria-label')||'')));}
const fn=(0,eval)(`(${fnSource})`); if(arguments[5]) return fn(items,...extra); const el=nth>=0?items[nth]:items[0]; if(!el)return {__aresMissing:true}; return fn(el,...extra);
"""
        value = self.adapter.execute_script(script, selector, nth, text_spec, function_source, args, all_items)
        if isinstance(value, dict) and value.get("__aresMissing"): raise LookupError(f"No element matched locator: {selector}")
        return value

    def _evaluate_function(self, source: str, args: List[Any]) -> Any:
        if not source: return None
        if source.lstrip().startswith(("return ", "const ", "let ", "var ")) or ("function" not in source and "=>" not in source): return self.adapter.execute_script(source, *args)
        return self.adapter.execute_script("const fn=(0,eval)(`(${arguments[0]})`); return fn(...arguments[1]);", source, args)

    def _in_frames(self, frame_path: Iterable[str], action: Any) -> Any:
        path = list(frame_path)
        if not path: return action()
        try:
            for selector in path: self.sb.switch_to_frame(selector)
            return action()
        finally:
            try: self.sb.switch_to_default_content()
            except Exception: pass

    def _wait_ready(self, timeout_ms: int) -> None:
        deadline = time.monotonic() + max(0.25, timeout_ms / 1000.0)
        while time.monotonic() < deadline:
            try:
                if str(self.adapter.execute_script("return document.readyState;") or "") in {"interactive", "complete"}: return
            except Exception: pass
            time.sleep(0.05)
        raise TimeoutError("document.readyState did not become interactive")

    def _mouse(self, action: str, command: Dict[str, Any]) -> bool:
        x, y = float(command.get("x") or 0), float(command.get("y") or 0)
        kind = "mousemove" if action == "mouse-move" else "click"
        script = "const x=Number(arguments[0]),y=Number(arguments[1]),t=String(arguments[2]);const e=document.elementFromPoint(x,y)||document.documentElement;e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window,button:0,buttons:t==='mousemove'?0:1}));return true;"
        return bool(self.adapter.execute_script(script, x, y, kind))


def run(start: Dict[str, Any]) -> int:
    if str(start.get("type") or "") != "start": raise ValueError("First command must be type='start'")
    profile_dir = Path(str(start.get("profileDir") or "")).expanduser().resolve(); profile_dir.mkdir(parents=True, exist_ok=True)
    adapter = SeleniumBaseCdpAdapter(profile_dir=profile_dir, headless=bool(start.get("headless", False)), proxy=as_proxy(start.get("proxy")), user_agent=str(start.get("userAgent") or "").strip() or None, browser_args=[str(v) for v in start.get("browserArgs") or []], language=str(start.get("locale") or "").strip() or None, timezone=str(start.get("timezoneId") or "").strip() or None)
    runtime = TaskRpcRuntime(adapter)
    commands: queue.Queue[Dict[str, Any]] = queue.Queue(); threading.Thread(target=command_reader, args=(commands,), daemon=True).start()
    emit({"type":"ready","requestId":str(start.get("requestId") or ""),"ok":True,"pid":adapter.chrome_pid,"profileDir":str(profile_dir)})
    closed = False
    try:
        while True:
            if not adapter.is_running(): break
            try: command = commands.get(timeout=0.25)
            except queue.Empty: continue
            request_id, command_type = str(command.get("requestId") or ""), str(command.get("type") or "")
            try:
                if command_type == "close": adapter.quit(); closed=True; emit({"type":"closed","requestId":request_id,"ok":True}); break
                if command_type == "apply-cookies":
                    cookies=command.get("cookies");
                    if not isinstance(cookies,list): raise TypeError("apply-cookies requires an array")
                    emit({"type":"cookies-applied","requestId":request_id,"ok":True,"result":adapter.set_snapshot_cookies(cookies)}); continue
                if command_type == "navigate": emit({"type":"navigated","requestId":request_id,"ok":True,**runtime.navigate(command)}); continue
                if command_type == "network-events": emit({"type":"network-events","requestId":request_id,"ok":True,**runtime.network_events()}); continue
                if command_type == "rpc": emit({"type":"rpc-result","requestId":request_id,"ok":True,**runtime.rpc(command)}); continue
                raise ValueError(f"Unsupported SeleniumBase task command: {command_type!r}")
            except Exception as exc: emit({"type":"error","requestId":request_id,"ok":False,"error":str(exc),"errorType":type(exc).__name__})
    finally:
        if not closed:
            try: adapter.quit()
            except Exception: pass
    return 0


def main() -> int:
    try: return run(read_first())
    except Exception as exc: emit({"type":"error","ok":False,"error":str(exc),"errorType":type(exc).__name__}); return 1


if __name__ == "__main__": raise SystemExit(main())
