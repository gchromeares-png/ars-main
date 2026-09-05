from __future__ import annotations

import json
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict

from seleniumbase_adapter import SeleniumBaseCdpAdapter

RESULT_PREFIX = "ARES_SB_MANUAL\t"
LAST_URL_FILENAME = ".ares-last-url"
SITE_ADAPTER_FILENAME = ".ares-site-adapter.json"


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


def _site_adapter_overrides(command: Dict[str, Any], profile_dir: Path) -> Dict[str, str]:
    inline = command.get("siteAdapterOverrides")
    if isinstance(inline, dict):
        return {str(key): str(value) for key, value in inline.items()}

    path = profile_dir / SITE_ADAPTER_FILENAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid {SITE_ADAPTER_FILENAME}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError(f"{SITE_ADAPTER_FILENAME} must contain a JSON object")
    return {str(key): str(value) for key, value in raw.items()}


def _restorable_url(value: str) -> bool:
    lowered = value.lower()
    return lowered.startswith("http://") or lowered.startswith("https://")


def _read_last_url(profile_dir: Path) -> str:
    try:
        value = (profile_dir / LAST_URL_FILENAME).read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    return value if _restorable_url(value) else ""


def _remember_last_url(profile_dir: Path, adapter: SeleniumBaseCdpAdapter, previous: str = "") -> str:
    try:
        value = str(adapter.execute_script("return window.location.href;") or "").strip()
    except Exception:
        return previous
    if not _restorable_url(value) or value == previous:
        return previous

    target = profile_dir / LAST_URL_FILENAME
    temporary = profile_dir / f"{LAST_URL_FILENAME}.tmp"
    try:
        temporary.write_text(value, encoding="utf-8")
        temporary.replace(target)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        return previous
    return value


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
    adapter = SeleniumBaseCdpAdapter(
        profile_dir=profile_dir,
        headless=False,
        proxy=_proxy_value(command),
        user_agent=str(command.get("userAgent") or "").strip() or None,
        site_adapter_overrides=_site_adapter_overrides(command, profile_dir),
    )
    closed = False
    last_url = _read_last_url(profile_dir)
    try:
        initial_cookies = command.get("cookies")
        applied = adapter.set_snapshot_cookies(initial_cookies) if isinstance(initial_cookies, list) and initial_cookies else 0

        start_url = str(command.get("startUrl") or "").strip() or last_url
        if start_url:
            adapter.goto(start_url)
            last_url = _remember_last_url(profile_dir, adapter, last_url)

        _emit({
            "type": "ready",
            "requestId": request_id,
            "profileId": profile_id,
            "profileDir": str(profile_dir),
            "pid": adapter.chrome_pid,
            "appliedCookieCount": applied,
            "siteAdapterEnabled": True,
            "gridActionsEnabled": True,
            "sliderActionsEnabled": True,
            "autoInteractionsEnabled": True,
            "semanticInteractionsEnabled": True,
        })

        commands: queue.Queue[Dict[str, Any]] = queue.Queue()
        threading.Thread(target=_command_reader, args=(commands,), daemon=True).start()
        next_url_capture = time.monotonic() + 2.0

        while True:
            if not adapter.is_running():
                _emit({"type": "browser-closed", "profileId": profile_id})
                break

            now = time.monotonic()
            if now >= next_url_capture:
                last_url = _remember_last_url(profile_dir, adapter, last_url)
                next_url_capture = now + 2.0

            try:
                next_command = commands.get(timeout=0.4)
            except queue.Empty:
                continue

            command_type = str(next_command.get("type") or "")
            next_request_id = str(next_command.get("requestId") or "")
            try:
                if command_type == "close":
                    last_url = _remember_last_url(profile_dir, adapter, last_url)
                    adapter.quit(); closed = True
                    _emit({"type": "closed", "requestId": next_request_id, "profileId": profile_id})
                    break
                if command_type == "export-cookies":
                    _emit({"type": "cookies", "requestId": next_request_id, "profileId": profile_id, "cookies": adapter.get_snapshot_cookies()}); continue
                if command_type == "apply-cookies":
                    cookies = next_command.get("cookies")
                    if not isinstance(cookies, list):
                        raise ValueError("apply-cookies requires a cookies array")
                    _emit({"type": "cookies-applied", "requestId": next_request_id, "profileId": profile_id, "count": adapter.set_snapshot_cookies(cookies)}); continue
                if command_type == "navigate":
                    url = str(next_command.get("url") or "").strip()
                    if not url:
                        raise ValueError("navigate requires a URL")
                    adapter.goto(url)
                    last_url = _remember_last_url(profile_dir, adapter, last_url)
                    _emit({"type": "navigated", "requestId": next_request_id, "profileId": profile_id}); continue
                if command_type == "inspect-session":
                    _emit({"type": "session-inspection", "requestId": next_request_id, "profileId": profile_id, **adapter.inspect_session()}); continue
                if command_type == "challenge-state":
                    _emit({"type": "challenge-state", "requestId": next_request_id, "profileId": profile_id, "state": adapter.challenge_state()}); continue
                if command_type == "site-grid-state":
                    _emit({"type": "site-grid-state", "requestId": next_request_id, "profileId": profile_id, "state": adapter.site_grid_state()}); continue
                if command_type == "site-slider-state":
                    _emit({"type": "site-slider-state", "requestId": next_request_id, "profileId": profile_id, "state": adapter.site_slider_state()}); continue
                if command_type == "auto-interaction-state":
                    _emit({"type": "auto-interaction-state", "requestId": next_request_id, "profileId": profile_id, "state": adapter.auto_interaction_state()}); continue
                if command_type == "observe-semantic-fields":
                    _emit({"type": "semantic-fields", "requestId": next_request_id, "profileId": profile_id, "fields": adapter.observe_semantic_fields()}); continue
                if command_type == "execute-semantic-plan":
                    plan = next_command.get("plan")
                    if not isinstance(plan, list):
                        raise ValueError("execute-semantic-plan requires a plan array")
                    result = adapter.execute_semantic_plan(plan)
                    _emit({"type": "semantic-plan-result", "requestId": next_request_id, "profileId": profile_id, **result}); continue
                if command_type == "apply-grid-selection":
                    indexes = next_command.get("indexes")
                    if not isinstance(indexes, list):
                        raise ValueError("apply-grid-selection requires an indexes array")
                    result = adapter.apply_grid_selection(indexes, submit=bool(next_command.get("submit", True)))
                    _emit({"type": "grid-selection-applied", "requestId": next_request_id, "profileId": profile_id, **result}); continue
                if command_type == "apply-slider":
                    target = float(next_command.get("targetFraction", 0.96))
                    result = adapter.apply_slider(target)
                    _emit({"type": "slider-applied", "requestId": next_request_id, "profileId": profile_id, **result}); continue
                if command_type == "status":
                    _emit({"type": "status", "requestId": next_request_id, "profileId": profile_id, "open": adapter.is_running(), "siteAdapterEnabled": True, "gridActionsEnabled": True, "sliderActionsEnabled": True, "autoInteractionsEnabled": True, "semanticInteractionsEnabled": True}); continue
                raise ValueError(f"Unsupported SeleniumBase command: {command_type!r}")
            except Exception as exc:
                _emit({"type": "error", "requestId": next_request_id, "profileId": profile_id, "errorType": type(exc).__name__, "error": str(exc)})
    finally:
        if not closed:
            try:
                _remember_last_url(profile_dir, adapter, last_url)
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
