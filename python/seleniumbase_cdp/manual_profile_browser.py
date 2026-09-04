from __future__ import annotations

import json
import queue
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List

import mycdp
from seleniumbase import sb_cdp

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


def _cookie_param(cookie: Dict[str, Any]) -> mycdp.network.CookieParam:
    partition_key = cookie.get("partitionKey")
    if partition_key:
        raise ValueError(
            "Partitionierte Cookies werden im SeleniumBase-Testpfad nicht stillschweigend umgeschrieben. "
            "Bitte Snapshot ohne partitionKey verwenden."
        )

    same_site = str(cookie.get("sameSite") or "Lax")
    if same_site not in {"Strict", "Lax", "None"}:
        same_site = "Lax"

    payload: Dict[str, Any] = {
        "name": str(cookie.get("name") or ""),
        "value": str(cookie.get("value") or ""),
        "domain": str(cookie.get("domain") or ""),
        "path": str(cookie.get("path") or "/"),
        "secure": bool(cookie.get("secure")),
        "httpOnly": bool(cookie.get("httpOnly")),
        "sameSite": same_site,
    }
    expires = cookie.get("expires")
    try:
        expires_number = float(expires)
    except (TypeError, ValueError):
        expires_number = -1
    if expires_number > 0:
        payload["expires"] = expires_number

    if not payload["name"] or not payload["domain"]:
        raise ValueError("Cookie ohne Name oder Domain kann nicht in SeleniumBase geladen werden.")
    return mycdp.network.CookieParam.from_json(payload)


def _apply_cookies(sb: Any, cookies: Iterable[Dict[str, Any]]) -> int:
    params = [_cookie_param(dict(cookie)) for cookie in cookies]
    if not params:
        return 0
    sb.set_all_cookies(params)
    return len(params)


def _cookie_to_snapshot(cookie: Any) -> Dict[str, Any]:
    if hasattr(cookie, "to_json"):
        raw = cookie.to_json()
    elif isinstance(cookie, dict):
        raw = dict(cookie)
    else:
        raw = {
            key: getattr(cookie, key)
            for key in dir(cookie)
            if not key.startswith("_") and not callable(getattr(cookie, key, None))
        }

    same_site = raw.get("sameSite") or raw.get("same_site") or "Lax"
    if hasattr(same_site, "to_json"):
        same_site = same_site.to_json()
    same_site = str(same_site)
    if same_site not in {"Strict", "Lax", "None"}:
        same_site = "Lax"

    expires = raw.get("expires", -1)
    if hasattr(expires, "to_json"):
        expires = expires.to_json()
    try:
        expires_number = float(expires)
    except (TypeError, ValueError):
        expires_number = -1

    snapshot: Dict[str, Any] = {
        "name": str(raw.get("name") or ""),
        "value": str(raw.get("value") or ""),
        "domain": str(raw.get("domain") or ""),
        "path": str(raw.get("path") or "/"),
        "expires": expires_number,
        "httpOnly": bool(raw.get("httpOnly", raw.get("http_only", False))),
        "secure": bool(raw.get("secure", False)),
        "sameSite": same_site,
    }

    partition_key = raw.get("partitionKey") or raw.get("partition_key")
    if isinstance(partition_key, str) and partition_key.strip():
        snapshot["partitionKey"] = partition_key.strip()
    elif isinstance(partition_key, dict) and partition_key.get("topLevelSite"):
        # ARES' current cross-engine snapshot contract stores the top-level site string.
        # Do not invent the missing hasCrossSiteAncestor bit on re-import; _cookie_param()
        # rejects partitioned snapshots instead of silently changing semantics.
        snapshot["partitionKey"] = str(partition_key["topLevelSite"])

    return snapshot


def _export_cookies(sb: Any) -> List[Dict[str, Any]]:
    cookies = sb.get_all_cookies()
    return [_cookie_to_snapshot(cookie) for cookie in cookies]


def _browser_running(sb: Any) -> bool:
    driver = getattr(sb, "driver", None)
    if driver is None:
        return False
    if hasattr(driver, "cdp_base"):
        driver = driver.cdp_base
    checker = getattr(driver, "is_running", None)
    if callable(checker):
        try:
            result = checker()
            return result is not False
        except Exception:
            return False
    return True


def _proxy_value(command: Dict[str, Any]) -> str | None:
    proxy = command.get("proxy")
    value = str(proxy or "").strip()
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
    profile_dir.mkdir(parents=True, exist_ok=True)

    request_id = str(command.get("requestId") or "")
    kwargs: Dict[str, Any] = {
        "user_data_dir": str(profile_dir),
        "headless": False,
    }
    proxy = _proxy_value(command)
    if proxy:
        kwargs["proxy"] = proxy
    user_agent = str(command.get("userAgent") or "").strip()
    if user_agent:
        kwargs["agent"] = user_agent

    sb = sb_cdp.Chrome(**kwargs)
    closed = False
    try:
        initial_cookies = command.get("cookies")
        applied = 0
        if isinstance(initial_cookies, list) and initial_cookies:
            applied = _apply_cookies(sb, initial_cookies)

        start_url = str(command.get("startUrl") or "").strip()
        if start_url:
            sb.goto(start_url)

        driver = getattr(sb, "driver", None)
        if hasattr(driver, "cdp_base"):
            driver = driver.cdp_base
        chrome_pid = getattr(driver, "_process_pid", None)
        _emit(
            {
                "type": "ready",
                "requestId": request_id,
                "profileId": profile_id,
                "profileDir": str(profile_dir),
                "pid": chrome_pid,
                "appliedCookieCount": applied,
            }
        )

        commands: queue.Queue[Dict[str, Any]] = queue.Queue()
        reader = threading.Thread(target=_command_reader, args=(commands,), daemon=True)
        reader.start()

        while True:
            if not _browser_running(sb):
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
                    sb.quit()
                    closed = True
                    _emit({"type": "closed", "requestId": next_request_id, "profileId": profile_id})
                    break
                if command_type == "export-cookies":
                    _emit(
                        {
                            "type": "cookies",
                            "requestId": next_request_id,
                            "profileId": profile_id,
                            "cookies": _export_cookies(sb),
                        }
                    )
                    continue
                if command_type == "apply-cookies":
                    cookies = next_command.get("cookies")
                    if not isinstance(cookies, list):
                        raise ValueError("apply-cookies requires a cookies array")
                    count = _apply_cookies(sb, cookies)
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
                    sb.goto(url)
                    _emit({"type": "navigated", "requestId": next_request_id, "profileId": profile_id})
                    continue
                if command_type == "status":
                    _emit(
                        {
                            "type": "status",
                            "requestId": next_request_id,
                            "profileId": profile_id,
                            "open": _browser_running(sb),
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
                sb.quit()
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
