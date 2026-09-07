from __future__ import annotations

import asyncio
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

PREFIX = "ARES_SESSION_HTTP\t"
QUEUE_RE = re.compile(r"(?i)(queue[-_.]?it|waiting[-_.]?room|warteschlange|queue-position|queue/status|\"ttw\"|\"position\")")
RELEASE_RE = re.compile(r"(?i)(released|complete|completed|redirect|passed|admitted)")


def emit(value: dict[str, Any]) -> None:
    print(PREFIX + json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def _num(value: Any) -> float | None:
    match = re.search(r"-?\d+(?:[.,]\d+)?", str(value or ""))
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", "."))
    except ValueError:
        return None


def classify(url: str, body: str) -> dict[str, Any]:
    position = None
    ttw = None
    status = ""
    try:
        payload = json.loads(body)
        if isinstance(payload, dict):
            data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            position = _num(payload.get("pos") or payload.get("position") or data.get("pos") or data.get("position"))
            ttw = _num(payload.get("ttw") or payload.get("timeToWait") or data.get("ttw") or data.get("timeToWait"))
            status = str(payload.get("status") or data.get("status") or "").strip()
    except Exception:
        pass

    # An explicit release status is authoritative. Queue endpoints commonly keep a
    # stable /queue/status URL after admission, so URL heuristics must not pin the
    # signal active forever once the response itself says the queue is released.
    released = bool(status and RELEASE_RE.search(status))
    active = False if released else bool(
        QUEUE_RE.search(url)
        or QUEUE_RE.search(body[:256000])
        or position is not None
        or ttw is not None
        or (status and re.search(r"(?i)(queue|wait|position|hold)", status))
    )
    return {"active": active, "position": position, "timeToWaitSeconds": ttw, "statusText": status or None}


def runtime_meta(profile_dir: Path) -> dict[str, Any]:
    path = profile_dir / ".ares-browser-runtime.json"
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(value, dict) and value.get("cdpPort"):
                return value
        except Exception:
            pass
        time.sleep(0.05)
    raise RuntimeError("browser runtime metadata unavailable")


def browser_ws(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as response:
        value = json.loads(response.read().decode("utf-8"))
    ws = str(value.get("webSocketDebuggerUrl") or "")
    if not ws:
        raise RuntimeError("browser CDP websocket unavailable")
    return ws


async def cdp_session(port: int, url: str) -> tuple[str, list[dict[str, Any]]]:
    import websockets

    async with websockets.connect(browser_ws(port), ping_timeout=20, max_size=2**22) as ws:
        next_id = 0

        async def call(method: str, params: dict[str, Any] | None = None, session_id: str | None = None) -> dict[str, Any]:
            nonlocal next_id
            next_id += 1
            payload: dict[str, Any] = {"id": next_id, "method": method, "params": params or {}}
            if session_id:
                payload["sessionId"] = session_id
            await ws.send(json.dumps(payload, separators=(",", ":")))
            while True:
                reply = json.loads(await ws.recv())
                if int(reply.get("id") or 0) != next_id:
                    continue
                if isinstance(reply.get("error"), dict):
                    raise RuntimeError(str(reply["error"].get("message") or "CDP command failed"))
                result = reply.get("result")
                return result if isinstance(result, dict) else {}

        version = await call("Browser.getVersion")
        targets = await call("Target.getTargets")
        infos = targets.get("targetInfos") if isinstance(targets.get("targetInfos"), list) else []
        target_id = next((str(item.get("targetId") or "") for item in infos if isinstance(item, dict) and item.get("type") == "page" and item.get("targetId")), "")
        if not target_id:
            raise RuntimeError("page target unavailable")
        attached = await call("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        session_id = str(attached.get("sessionId") or "")
        if not session_id:
            raise RuntimeError("CDP attach failed")
        try:
            await call("Network.enable", {}, session_id)
            cookies = await call("Network.getCookies", {"urls": [url]}, session_id)
            raw = cookies.get("cookies") if isinstance(cookies.get("cookies"), list) else []
            return str(version.get("userAgent") or ""), [item for item in raw if isinstance(item, dict)]
        finally:
            try:
                await call("Target.detachFromTarget", {"sessionId": session_id})
            except Exception:
                pass


def poll(command: dict[str, Any]) -> dict[str, Any]:
    from curl_cffi import requests

    url = str(command.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise ValueError("http(s) url required")
    meta = runtime_meta(Path(str(command.get("profileDir") or "")).expanduser().resolve())
    ua, cookies = asyncio.run(cdp_session(int(meta.get("cdpPort") or 0), url))
    headers = {"User-Agent": ua, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"}
    cookie_header = "; ".join(f"{c.get('name')}={c.get('value', '')}" for c in cookies if c.get("name"))
    if cookie_header:
        headers["Cookie"] = cookie_header
    kwargs: dict[str, Any] = {"headers": headers, "timeout": 6, "allow_redirects": True, "impersonate": "chrome"}
    proxy = str(command.get("proxy") or "").strip()
    if proxy:
        kwargs["proxy"] = proxy
    response = requests.get(url, **kwargs)
    signal = classify(str(response.url or url), str(response.text or "")[:256000])
    return {"type": "probe", "ok": True, "source": "session-http", "statusCode": int(response.status_code), "url": str(response.url or url), "cookieCount": len(cookies), "observedAtMs": int(time.time() * 1000), **signal}


def main() -> int:
    line = sys.stdin.readline()
    if not line:
        return 2
    command = json.loads(line)
    interval = max(1000, min(10000, int(command.get("pollIntervalMs") or 2000))) / 1000
    while True:
        started = time.monotonic()
        try:
            emit(poll(command))
        except Exception as exc:
            emit({"type": "probe", "ok": False, "active": False, "source": "session-http", "errorType": type(exc).__name__, "error": str(exc)[:1000], "observedAtMs": int(time.time() * 1000)})
        time.sleep(max(0.05, interval - (time.monotonic() - started)))


if __name__ == "__main__":
    raise SystemExit(main())
