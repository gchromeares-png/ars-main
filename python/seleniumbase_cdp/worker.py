from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict

from seleniumbase_adapter import SeleniumBaseCdpAdapter

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

    adapter = SeleniumBaseCdpAdapter(profile_dir=profile_dir, headless=headless)
    try:
        adapter.goto(url)

        if action == "seed-persistence":
            if not token:
                raise ValueError("seed-persistence requires a non-empty token")
            adapter.set_snapshot_cookies([
                {
                    "name": COOKIE_NAME,
                    "value": token,
                    "domain": "127.0.0.1",
                    "path": "/",
                    "expires": 4102444800,
                    "httpOnly": False,
                    "secure": False,
                    "sameSite": "Lax",
                }
            ])
            adapter.execute_script(
                "localStorage.setItem("
                f"{json.dumps(STORAGE_KEY)}, {json.dumps(token)}"
                ");"
            )
            adapter.sleep(0.25)

        cookies = adapter.get_snapshot_cookies()
        storage_value = adapter.execute_script(
            f"return localStorage.getItem({json.dumps(STORAGE_KEY)});"
        )

        return {
            "ok": True,
            "action": action,
            "profile_dir": str(profile_dir),
            "cookies": cookies,
            "storage_value": storage_value,
        }
    finally:
        adapter.quit()


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
