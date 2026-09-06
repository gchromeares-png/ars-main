from __future__ import annotations

import json
import queue
import re
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List

import mycdp
from seleniumbase_adapter import SeleniumBaseCdpAdapter

PREFIX = "ARES_SB_TASK\t"
MAX_RESPONSE_BODY = 256_000
MAX_NETWORK_EVENTS = 50
MAX_DISCOVERED_FRAMES = 128
_CONTEXT_RETRY_ERRORS = (
    "execution context was destroyed",
    "cannot find context",
    "inspected target navigated or closed",
    "target closed",
    "no frame with given id",
)
_QUEUE_URL_RE = re.compile(
    r"(?i)(queue[-_.]?it|waiting[-_.]?room|waitingroom|/queue(?:/|\?|$)|queue-token|queue/status|checkpoint|throttle)"
)
_TEXT_MIME_RE = re.compile(r"(?i)^(?:application/(?:json|[^;]+\+json)|text/(?:html|plain))(?:;|$)")
_FRAME_DESCRIPTORS_SCRIPT = r"""
const selectorFor = (element) => {
  const parts = [];
  let node = element;
  while (node && node.nodeType === 1) {
    if (node === document.documentElement) {
      parts.unshift('html');
      break;
    }
    const parent = node.parentElement;
    if (!parent) break;
    const index = Array.prototype.indexOf.call(parent.children, node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
    node = parent;
  }
  return parts.join(' > ');
};
return Array.from(document.querySelectorAll('iframe,frame')).map((element, ordinal) => ({
  selector: selectorFor(element),
  name: String(element.getAttribute('name') || element.getAttribute('id') || ''),
  src: String(element.getAttribute('src') || ''),
  ordinal,
}));
"""


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
if (action === 'click') {
  el.scrollIntoView({block:'center',inline:'nearest'});
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return {
    nativeClick: true,
    visible: visible(el),
    enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    hit: !!hit && (hit === el || el.contains(hit)),
    x, y, width: r.width, height: r.height,
  };
}
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
    def __init__(self, adapter: SeleniumBaseCdpAdapter, *, user_agent: str | None = None, language: str | None = None) -> None:
        self.adapter = adapter
        self.sb = getattr(adapter, "_sb")
        self._network_lock = threading.Lock()
        self._network_events: Deque[Dict[str, Any]] = deque(maxlen=MAX_NETWORK_EVENTS)
        self._last_tab_count = 1
        self._active_frame_path: List[str] = []
        self._install_network_handler()
        self._install_dialog_handler()
        self._apply_user_agent_override(user_agent, language)

    def _install_network_handler(self) -> None:
        try:
            self.sb.add_handler(mycdp.network.ResponseReceived, self._on_response)
        except Exception:
            pass

    def _install_dialog_handler(self) -> None:
        event_type = getattr(getattr(mycdp, "page", None), "JavascriptDialogOpening", None)
        if event_type is None:
            return
        try:
            self.sb.add_handler(event_type, self._on_dialog)
        except Exception:
            pass

    async def _on_dialog(self, event: Any) -> None:
        try:
            tab = self.sb.get_active_tab()
            command = getattr(getattr(mycdp, "page", None), "handle_java_script_dialog", None)
            if callable(command):
                await tab.send(command(accept=True))
        except Exception:
            pass

    async def _on_response(self, event: mycdp.network.ResponseReceived) -> None:
        response = event.response
        url = str(response.url or "")
        mime = str(response.mime_type or "").split(";", 1)[0].strip().lower()
        if not _QUEUE_URL_RE.search(url):
            return
        if not _TEXT_MIME_RE.search(mime):
            return
        headers = {str(key).lower(): str(value) for key, value in dict(response.headers or {}).items()}
        with self._network_lock:
            self._network_events.append({
                "url": url,
                "headers": headers,
                "mimeType": mime,
                "requestId": event.request_id,
            })

    def _apply_user_agent_override(self, user_agent: str | None, language: str | None) -> None:
        if not user_agent:
            return
        command = getattr(getattr(mycdp, "network", None), "set_user_agent_override", None)
        if not callable(command):
            return
        try:
            tab = self.sb.get_active_tab()
            loop = self.sb.get_event_loop()
            kwargs: Dict[str, Any] = {"user_agent": str(user_agent)}
            if language:
                kwargs["accept_language"] = str(language)
            loop.run_until_complete(tab.send(command(**kwargs)))
        except Exception:
            pass

    def add_init_script(self, script: str) -> Dict[str, Any]:
        source = str(script or "")
        if not source.strip():
            return {"result": False}
        command = getattr(getattr(mycdp, "page", None), "add_script_to_evaluate_on_new_document", None)
        if not callable(command):
            raise RuntimeError("CDP Page.addScriptToEvaluateOnNewDocument is unavailable")
        tab = self.sb.get_active_tab()
        loop = self.sb.get_event_loop()
        result = loop.run_until_complete(tab.send(command(source=source)))
        return {"result": True, "identifier": str(result or "")}

    def _sync_newest_target(self) -> None:
        try:
            tabs = list(self.sb.get_tabs() or [])
        except Exception:
            tabs = []
        if len(tabs) > self._last_tab_count:
            try:
                self.sb.switch_to_tab(tabs[-1])
            except Exception:
                try:
                    self.sb.switch_to_newest_tab()
                except Exception:
                    pass
        self._last_tab_count = max(1, len(tabs)) if tabs else self._last_tab_count
        try:
            self.sb.switch_to_newest_window()
        except Exception:
            pass

    def navigate(self, command: Dict[str, Any]) -> Dict[str, Any]:
        url = str(command.get("url") or "").strip()
        if not url:
            raise ValueError("navigate requires url")
        self.adapter.goto(url)
        self._sync_newest_target()
        return {"url": str(self.sb.get_current_url() or url), "result": True}

    def network_events(self) -> Dict[str, Any]:
        with self._network_lock:
            items = list(self._network_events)
            self._network_events.clear()
        if not items:
            return {"events": [], "url": str(self.sb.get_current_url() or "")}

        tab = self.sb.get_active_tab()
        loop = self.sb.get_event_loop()
        output: List[Dict[str, Any]] = []
        for item in items:
            event = {"url": item["url"], "headers": item["headers"]}
            try:
                body, is_base64 = loop.run_until_complete(tab.send(mycdp.network.get_response_body(item["requestId"])))
                if not is_base64 and isinstance(body, str):
                    event["body"] = body[:MAX_RESPONSE_BODY]
            except Exception:
                pass
            output.append(event)
        return {"events": output, "url": str(self.sb.get_current_url() or "")}

    def page_state(self) -> Dict[str, Any]:
        try:
            url = str(self.sb.get_current_url() or "")
        except Exception:
            url = ""
        try:
            ready_state = str(self.adapter.execute_script("return document.readyState;") or "")
        except Exception:
            ready_state = ""
        return {
            "url": url,
            "readyState": ready_state,
            "frames": self._discover_frame_tree(),
        }

    def _discover_frame_tree(self) -> List[Dict[str, Any]]:
        queue_paths: Deque[List[str]] = deque([[]])
        entries: Dict[tuple[str, ...], Dict[str, Any]] = {}
        visited: set[tuple[str, ...]] = set()

        while queue_paths and len(entries) < MAX_DISCOVERED_FRAMES:
            path = queue_paths.popleft()
            key = tuple(path)
            if key in visited:
                continue
            visited.add(key)
            try:
                current_url, raw_descriptors = self._in_frames(
                    path,
                    lambda: (
                        str(self.sb.get_current_url() or "") if not path else str(self._execute_script_in_frame_path(path, "return window.location.href;", []) or ""),
                        self._execute_script_in_frame_path(path, _FRAME_DESCRIPTORS_SCRIPT, []),
                    ),
                )
            except Exception:
                continue
            if path:
                entries[key] = {
                    "path": list(path),
                    "url": current_url,
                    "name": entries.get(key, {}).get("name", ""),
                    "depth": len(path),
                }
            if not isinstance(raw_descriptors, list):
                continue
            for raw in raw_descriptors:
                if not isinstance(raw, dict):
                    continue
                selector = str(raw.get("selector") or "").strip()
                if not selector:
                    continue
                child_path = [*path, selector]
                child_key = tuple(child_path)
                if child_key not in entries:
                    entries[child_key] = {
                        "path": child_path,
                        "url": str(raw.get("src") or ""),
                        "name": str(raw.get("name") or ""),
                        "depth": len(child_path),
                    }
                if child_key not in visited and len(entries) < MAX_DISCOVERED_FRAMES:
                    queue_paths.append(child_path)
        return list(entries.values())

    def _execute_script_in_frame_path(self, frame_path: Iterable[str], script: str, args: Iterable[Any]) -> Any:
        path = [str(value) for value in frame_path if str(value)]
        if not path:
            return self.adapter.execute_script(script, *list(args))
        return self._in_frames(path, lambda: self.adapter.execute_script(script, *list(args)))

    def _frame_viewport_offset(self, frame_path: Iterable[str]) -> tuple[float, float]:
        path = [str(value) for value in frame_path if str(value)]
        if not path:
            return 0.0, 0.0
        x = 0.0
        y = 0.0
        prefix: List[str] = []
        for selector in path:
            box = self._execute_script_in_frame_path(prefix, """
const selector=String(arguments[0]||'');
const frame=document.querySelector(selector);
if(!frame) return null;
frame.scrollIntoView({block:'nearest',inline:'nearest'});
const r=frame.getBoundingClientRect();
return {x:r.left+Number(frame.clientLeft||0),y:r.top+Number(frame.clientTop||0),width:r.width,height:r.height};
""", [selector])
            if not isinstance(box, dict) or float(box.get("width") or 0) <= 0 or float(box.get("height") or 0) <= 0:
                raise LookupError(f"Frame is not visible for native click: {selector}")
            x += float(box.get("x") or 0.0)
            y += float(box.get("y") or 0.0)
            prefix.append(selector)
        return x, y

    def _in_frames(self, frame_path: Iterable[str], callback: Any) -> Any:
        path = [str(value) for value in frame_path if str(value)]
        if not path:
            return callback()
        switched = False
        try:
            for selector in path:
                self.sb.switch_to_frame(selector)
                switched = True
            return callback()
        finally:
            if switched:
                try:
                    self.sb.switch_to_default_content()
                except Exception:
                    pass

    def rpc(self, command: Dict[str, Any]) -> Dict[str, Any]:
        method = str(command.get("method") or "").strip()
        params = command.get("params") if isinstance(command.get("params"), dict) else {}
        if method == "browser.newPage":
            url = str(params.get("url") or "about:blank")
            self.sb.open_new_tab(url)
            self._sync_newest_target()
            return {"result": True, "url": str(self.sb.get_current_url() or url)}
        if method == "browser.pages":
            return {"result": self._page_descriptors()}
        if method == "page.state":
            return {"result": self.page_state()}
        if method == "page.evaluate":
            frame_path = [str(value) for value in params.get("framePath") or []]
            script = str(params.get("script") or "")
            args = list(params.get("args") or [])
            return {"result": self._execute_script_in_frame_path(frame_path, script, args)}
        if method == "locator.count":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="count")}
        if method == "locator.isVisible":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="is-visible")}
        if method == "locator.isEnabled":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="is-enabled")}
        if method == "locator.inputValue":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="input-value")}
        if method == "locator.innerText":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="inner-text")}
        if method == "locator.allTextContents":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="all-text-contents")}
        if method == "locator.boundingBox":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="bounding-box")}
        if method == "locator.scrollIntoViewIfNeeded":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="scroll-into-view")}
        if method == "locator.focus":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="focus")}
        if method == "locator.click":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="click")}
        if method == "locator.fill":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="fill", payload={"value": params.get("value")})}
        if method == "locator.selectOption":
            return {"result": self._locator(frame_path=params.get("framePath"), selector=params.get("selector"), text=params.get("text"), nth=params.get("nth"), action="select-option", payload={"value": params.get("value")})}
        if method == "page.waitForTimeout":
            time.sleep(max(0.0, float(params.get("ms") or 0.0)) / 1000.0)
            return {"result": True}
        if method == "page.capture":
            return {"result": self._capture_page(params)}
        if method == "page.reload":
            self.sb.refresh()
            self._sync_newest_target()
            return {"result": True, "url": str(self.sb.get_current_url() or "")}
        if method == "page.close":
            self.sb.close()
            self._sync_newest_target()
            return {"result": True}
        raise ValueError(f"Unsupported RPC method: {method}")

    def _locator(self, *, frame_path: Any, selector: Any, text: Any, nth: Any, action: str, payload: Dict[str, Any] | None = None) -> Any:
        frame_path_list = [str(value) for value in frame_path or []]
        selector_text = str(selector or "").strip()
        if not selector_text:
            raise ValueError(f"{action} requires selector")
        text_spec = pattern_payload(text)
        nth_value = -1 if nth is None else int(nth)
        result = self._execute_script_in_frame_path(
            frame_path_list,
            locator_script(),
            [selector_text, nth_value, text_spec, action, payload or {}],
        )
        if isinstance(result, dict) and result.get("__aresMissing"):
            return None
        if action == "click" and isinstance(result, dict) and result.get("nativeClick"):
            if not result.get("visible") or not result.get("enabled") or not result.get("hit"):
                return False
            offset_x, offset_y = self._frame_viewport_offset(frame_path_list)
            x = float(result.get("x") or 0.0) + offset_x
            y = float(result.get("y") or 0.0) + offset_y
            return bool(self._native_click(x, y))
        return result

    def _native_click(self, x: float, y: float) -> bool:
        try:
            self.sb.gui_click_x_y(float(x), float(y), timeframe=0.18)
            return True
        except Exception:
            return False

    def _page_descriptors(self) -> List[Dict[str, Any]]:
        try:
            tabs = list(self.sb.get_tabs() or [])
        except Exception:
            tabs = []
        result: List[Dict[str, Any]] = []
        for index, tab in enumerate(tabs):
            result.append({
                "id": str(getattr(tab, "target_id", None) or getattr(getattr(tab, "target", None), "target_id", None) or index),
                "url": str(getattr(tab, "url", "") or ""),
                "active": index == len(tabs) - 1,
            })
        return result

    def _capture_page(self, params: Dict[str, Any]) -> Dict[str, Any]:
        path = Path(str(params.get("path") or "")).expanduser().resolve()
        if not str(path):
            raise ValueError("page.capture requires path")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.sb.save_screenshot(path.name, folder=str(path.parent))
        return {"path": str(path), "exists": path.exists(), "bytes": path.stat().st_size if path.exists() else 0}


def run(start: Dict[str, Any]) -> int:
    if str(start.get("type") or "") != "start":
        raise ValueError("First command must be type='start'")
    profile_dir = Path(str(start.get("profileDir") or "")).expanduser().resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    user_agent = str(start.get("userAgent") or "").strip() or None
    language = str(start.get("locale") or "").strip() or None
    adapter = SeleniumBaseCdpAdapter(
        profile_dir=profile_dir,
        headless=bool(start.get("headless", False)),
        proxy=as_proxy(start.get("proxy")),
        user_agent=user_agent,
        browser_args=[str(v) for v in start.get("browserArgs") or []],
        language=language,
        timezone=str(start.get("timezoneId") or "").strip() or None,
    )
    runtime = TaskRpcRuntime(adapter, user_agent=user_agent, language=language)
    commands: queue.Queue[Dict[str, Any]] = queue.Queue()
    threading.Thread(target=command_reader, args=(commands,), daemon=True).start()
    emit({
        "type": "ready",
        "requestId": str(start.get("requestId") or ""),
        "ok": True,
        "pid": adapter.chrome_pid,
        "profileDir": str(profile_dir),
    })
    closed = False
    try:
        while True:
            if not adapter.is_running():
                break
            try:
                command = commands.get(timeout=0.25)
            except queue.Empty:
                adapter.poll_runtime()
                continue
            request_id = str(command.get("requestId") or "")
            command_type = str(command.get("type") or "")
            try:
                if command_type == "close":
                    adapter.quit()
                    closed = True
                    emit({"type": "closed", "requestId": request_id, "ok": True})
                    break
                if command_type == "apply-cookies":
                    cookies = command.get("cookies")
                    if not isinstance(cookies, list):
                        raise TypeError("apply-cookies requires an array")
                    emit({
                        "type": "cookies-applied",
                        "requestId": request_id,
                        "ok": True,
                        "result": adapter.set_snapshot_cookies(cookies),
                    })
                    continue
                if command_type == "add-init-script":
                    emit({
                        "type": "init-script-added",
                        "requestId": request_id,
                        "ok": True,
                        **runtime.add_init_script(str(command.get("script") or "")),
                    })
                    continue
                if command_type == "navigate":
                    emit({"type": "navigated", "requestId": request_id, "ok": True, **runtime.navigate(command)})
                    continue
                if command_type == "network-events":
                    emit({"type": "network-events", "requestId": request_id, "ok": True, **runtime.network_events()})
                    continue
                if command_type == "rpc":
                    emit({"type": "rpc-result", "requestId": request_id, "ok": True, **runtime.rpc(command)})
                    continue
                raise ValueError(f"Unsupported SeleniumBase task command: {command_type!r}")
            except Exception as exc:
                emit({
                    "type": "error",
                    "requestId": request_id,
                    "ok": False,
                    "error": str(exc),
                    "errorType": type(exc).__name__,
                })
    finally:
        if not closed:
            try:
                adapter.quit()
            except Exception:
                pass
    return 0


def main() -> int:
    try:
        return run(read_first())
    except Exception as exc:
        emit({"type": "error", "ok": False, "error": str(exc), "errorType": type(exc).__name__})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
