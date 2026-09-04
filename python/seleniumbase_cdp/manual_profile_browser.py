from __future__ import annotations

import json
import queue
import sys
import threading
from pathlib import Path
from typing import Any, Dict

from seleniumbase_adapter import SeleniumBaseCdpAdapter

RESULT_PREFIX = "ARES_SB_MANUAL\t"


def _emit(payload: Dict[str, Any]) -> None:
    print(f"{RESULT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def _read_first_command() -> Dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("No SeleniumBase start command received on stdin")
    command = json.loads(line)
    if not isinstance(command, dict):
        raise TypeError("SeleniumBase command must be a JSON object")
    return command


def _command_reader(target: queue.Queue[Dict[str, Any]]) -> None:
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            command = json.loads(raw)
            if isinstance(command, dict):
                target.put(command)
        except Exception as exc:
            _emit({"type": "error", "error": f"Invalid worker command: {exc}"})


def _proxy_value(command: Dict[str, Any]) -> str | None:
    value = str(command.get("proxy") or "").strip()
    return value or None


def _start(command: Dict[str, Any]) -> int:
    if str(command.get("type") or "") != "start":
        raise ValueError("First SeleniumBase command must be type='start'")

    profile_id = str(command.get("profileId") or "").strip()
    profile_dir = Path(str(command.get("profileDir") or "")).expanduser().resolve()
    if not profile_id:
        raise ValueError("profileId is required")
    if not str(profile_dir):
        raise ValueError("profileDir is required")

    request_id = str(command.get("requestId") or "")
    user_agent = str(command.get("userAgent") or "").strip() or None
    adapter = SeleniumBaseCdpAdapter(
        profile_dir=profile_dir,
        headless=False,
        proxy=_proxy_value(command),
        user_agent=user_agent,
    )
    closed = False
    try:
        initial_cookies = command.get("cookies")
        applied = 0
        if isinstance(initial_cookies, list) and initial_cookies:
            applied = adapter.set_snapshot_cookies(initial_cookies)

        start_url = str(command.get("startUrl") or "").strip()
        if start_url:
            adapter.goto(start_url)

        _emit(
            {
                "type": "ready",
                "requestId": request_id,
                "profileId": profile_id,
                "profileDir": str(profile_dir),
                "pid": adapter.chrome_pid,
                "appliedCookieCount": applied,
            }
        )

        commands: queue.Queue[Dict[str, Any]] = queue.Queue()
        reader = threading.Thread(target=_command_reader, args=(commands,), daemon=True)
        reader.start()

        while True:
            if not adapter.is_running():
                _emit({"type": "browser-closed", "profileId": profile_id})
                break
            try:
                next_command = commands.get(timeout=0.4)
            except queue.Empty:
                continue

            command_type = str(next_command.get("type") or "")
            next_request_id = str(next_command.get("requestId") or "")
            try:
                if command_type == "close":
                    adapter.quit()
                    closed = True
                    _emit({"type": "closed", "requestId": next_request_id, "profileId": profile_id})
                    break
                if command_type == "export-cookies":
                    _emit(
                        {
                            "type": "cookies",
                            "requestId": next_request_id,
                            "profileId": profile_id,
                            "cookies": adapter.get_snapshot_cookies(),
                        }
                    )
                    continue
                if command_type == "apply-cookies":
                    cookies = next_command.get("cookies")
                    if not isinstance(cookies, list):
                        raise ValueError("apply-cookies requires a cookies array")
                    count = adapter.set_snapshot_cookies(cookies)
                    _emit(
                        {
                            "type": "cookies-applied",
                            "requestId": next_request_id,
                            "profileId": profile_id,
                            "count": count,
                        }
                    )
                    continue
                if command_type == "navigate":
                    url = str(next_command.get("url") or "").strip()
                    if not url:
                        raise ValueError("navigate requires a URL")
                    adapter.goto(url)
                    _emit({"type": "navigated", "requestId": next_request_id, "profileId": profile_id})
                    continue
                if command_type == "status":
                    _emit(
                        {
                            "type": "status",
                            "requestId": next_request_id,
                            "profileId": profile_id,
                            "open": adapter.is_running(),
                        }
                    )
                    continue
                raise ValueError(f"Unsupported SeleniumBase command: {command_type!r}")
            except Exception as exc:
                _emit(
                    {
                        "type": "error",
                        "requestId": next_request_id,
                        "profileId": profile_id,
                        "errorType": type(exc).__name__,
                        "error": str(exc),
                    }
                )
    finally:
        if not closed:
            try:
                adapter.quit()
            except Exception:
                pass
    return 0


def main() -> int:
    try:
        return _start(_read_first_command())
    except Exception as exc:
        _emit({"type": "error", "errorType": type(exc).__name__, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
