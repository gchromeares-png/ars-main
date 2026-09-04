from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict

from seleniumbase import sb_cdp

RESULT_PREFIX = "ARES_SB_RESULT\t"
COOKIE_NAME = "ares_sb_profile_probe"
STORAGE_KEY = "ares_sb_profile_probe"


def _emit(payload: Dict[str, Any]) -> None:
    print(f"{RESULT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def _read_command() -> Dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("No JSON command received on stdin")
    command = json.loads(line)
    if not isinstance(command, dict):
        raise TypeError("Worker command must be a JSON object")
    return command


def _run(command: Dict[str, Any]) -> Dict[str, Any]:
    action = str(command.get("action", "")).strip()
    if action not in {"seed-persistence", "read-persistence"}:
        raise ValueError(f"Unsupported action: {action!r}")

    profile_dir = Path(str(command["profile_dir"])).expanduser().resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)

    url = str(command["url"])
    headless = bool(command.get("headless", True))
    token = str(command.get("token", ""))

    sb = sb_cdp.Chrome(
        user_data_dir=str(profile_dir),
        headless=headless,
    )
    try:
        sb.goto(url)

        if action == "seed-persistence":
            if not token:
                raise ValueError("seed-persistence requires a non-empty token")

            cookie_value = f"{COOKIE_NAME}={token}; Max-Age=86400; Path=/; SameSite=Lax"
            sb.execute_script(
                f"document.cookie = {json.dumps(cookie_value)};"
            )
            sb.execute_script(
                "localStorage.setItem("
                f"{json.dumps(STORAGE_KEY)}, {json.dumps(token)}"
                ");"
            )
            sb.sleep(0.25)

        cookie_text = sb.execute_script("return document.cookie;") or ""
        storage_value = sb.execute_script(
            f"return localStorage.getItem({json.dumps(STORAGE_KEY)});"
        )

        return {
            "ok": True,
            "action": action,
            "profile_dir": str(profile_dir),
            "cookie_text": str(cookie_text),
            "storage_value": storage_value,
        }
    finally:
        sb.quit()


def main() -> int:
    try:
        result = _run(_read_command())
        _emit(result)
        return 0
    except Exception as exc:
        _emit(
            {
                "ok": False,
                "error_type": type(exc).__name__,
                "error": str(exc),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
