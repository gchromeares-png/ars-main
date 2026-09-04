from __future__ import annotations

import argparse
import http.server
import json
import secrets
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Tuple

RESULT_PREFIX = "ARES_SB_RESULT\t"
WORKER_PATH = Path(__file__).with_name("worker.py")
COOKIE_NAME = "ares_sb_profile_probe"


class QuietHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
        body = b"<!doctype html><html><body>ARES SeleniumBase CDP persistence probe</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def _start_server() -> Tuple[ReusableTCPServer, threading.Thread, str]:
    server = ReusableTCPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, thread, f"http://{host}:{port}/"


def _parse_result(stdout: str) -> Dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        if line.startswith(RESULT_PREFIX):
            payload = json.loads(line[len(RESULT_PREFIX):])
            if not isinstance(payload, dict):
                raise RuntimeError("Worker result was not a JSON object")
            return payload
    raise RuntimeError(f"Worker emitted no ARES result marker. Output tail: {stdout[-1200:]}")


def _run_worker(
    *,
    action: str,
    profile_dir: Path,
    url: str,
    headless: bool,
    token: str = "",
) -> Dict[str, Any]:
    command = {
        "action": action,
        "profile_dir": str(profile_dir),
        "url": url,
        "headless": headless,
        "token": token,
    }
    completed = subprocess.run(
        [sys.executable, str(WORKER_PATH)],
        input=json.dumps(command) + "\n",
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    result = _parse_result(completed.stdout)
    if completed.returncode != 0 or not result.get("ok"):
        raise RuntimeError(
            "SeleniumBase worker failed: "
            f"returncode={completed.returncode}, result={result}, stderr={completed.stderr[-1200:]}"
        )
    return result


def _assert_persisted(result: Dict[str, Any], token: str) -> None:
    cookie_text = str(result.get("cookie_text", ""))
    storage_value = result.get("storage_value")
    expected_cookie = f"{COOKIE_NAME}={token}"
    if expected_cookie not in cookie_text:
        raise AssertionError(f"Persistent cookie missing after restart: {cookie_text!r}")
    if storage_value != token:
        raise AssertionError(
            f"LocalStorage missing after restart: expected {token!r}, got {storage_value!r}"
        )


def _run_probe(profile_dir: Path, headed: bool) -> None:
    server, thread, url = _start_server()
    token = secrets.token_hex(16)
    try:
        first = _run_worker(
            action="seed-persistence",
            profile_dir=profile_dir,
            url=url,
            headless=not headed,
            token=token,
        )
        _assert_persisted(first, token)

        # This is intentionally a second Python process. The only shared browser
        # state is SeleniumBase's own user_data_dir on disk.
        second = _run_worker(
            action="read-persistence",
            profile_dir=profile_dir,
            url=url,
            headless=not headed,
        )
        _assert_persisted(second, token)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify SeleniumBase pure-CDP profile persistence across two isolated Python processes."
    )
    parser.add_argument(
        "--profile-dir",
        type=Path,
        help="Optional dedicated SeleniumBase profile directory. A temporary directory is used by default.",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run Chrome headed instead of headless.",
    )
    args = parser.parse_args()

    if args.profile_dir:
        profile_dir = args.profile_dir.expanduser().resolve()
        profile_dir.mkdir(parents=True, exist_ok=True)
        _run_probe(profile_dir, args.headed)
        print(f"PASS: SeleniumBase CDP persistence verified in {profile_dir}")
        return 0

    with tempfile.TemporaryDirectory(prefix="ares-seleniumbase-cdp-") as temp_root:
        profile_dir = Path(temp_root) / "profile"
        _run_probe(profile_dir, args.headed)
        print("PASS: SeleniumBase CDP persistence verified across two isolated Python processes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
