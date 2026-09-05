from __future__ import annotations

import secrets
import shutil
import tempfile
from pathlib import Path

from manual_profile_probe import (
    COOKIE_A,
    WorkerClient,
    _assert_cookie,
    _cookie,
    _next_request,
    _start_server,
)

RESTORE_PATH = "/restore-target"


def _run(profile_dir: Path) -> None:
    server, recorder, base_url = _start_server()
    token = secrets.token_hex(8)
    active: WorkerClient | None = None
    try:
        target_url = f"{base_url}{RESTORE_PATH}"
        active = WorkerClient(profile_dir, target_url, [_cookie(COOKIE_A, token)])
        initial = _next_request(recorder, RESTORE_PATH)
        _assert_cookie(initial["cookie"], COOKIE_A, token)
        active.close()
        active = None

        # Reopen twice without any explicit startUrl. Both launches must restore
        # the previous SeleniumBase-owned page as the active page and keep the
        # persistent cookie. This catches immediate Windows close/reopen races.
        for index in range(2):
            active = WorkerClient(profile_dir, "")
            restored = _next_request(recorder, RESTORE_PATH, timeout=25)
            _assert_cookie(restored["cookie"], COOKIE_A, token)

            request_id = f"inspect-{index}"
            active.send({"type": "inspect-session", "requestId": request_id})
            inspected = active.wait("session-inspection", request_id, 15)
            if inspected.get("url") != target_url:
                raise AssertionError(
                    f"Reopened SeleniumBase profile did not restore the active page: {inspected}"
                )

            active.close()
            active = None
    finally:
        if active:
            try:
                active.close()
            except Exception:
                active.process.kill()
        server.shutdown()
        server.server_close()


def main() -> int:
    temporary = tempfile.mkdtemp(prefix="ares-sb-reopen-")
    profile_dir = Path(temporary) / "profile" / ".ares-seleniumbase-cdp"
    try:
        _run(profile_dir)
        print("SeleniumBase clean reopen restored the active page and persistent cookies twice.")
        return 0
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
