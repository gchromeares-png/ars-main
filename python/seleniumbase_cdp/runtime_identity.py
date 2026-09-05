from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List

import psutil

RUNTIME_ENV = "ARES_BROWSER_SESSION_ID"
RUNTIME_ARG_PREFIX = "--ares-session-id="
DEBUG_PORT_PREFIX = "--remote-debugging-port="
RUNTIME_FILENAME = ".ares-browser-runtime.json"
_BROWSER_NAME_MARKERS = ("chrome", "chromium", "msedge")


class BrowserRuntimeIdentity:
    """ARES-owned identity for one Python worker -> one Chromium runtime."""

    def __init__(self, profile_dir: str | Path, session_id: str | None = None) -> None:
        self.profile_dir = Path(profile_dir).expanduser().resolve()
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self.session_id = str(session_id or uuid.uuid4().hex).strip() or uuid.uuid4().hex
        self.worker_pid = os.getpid()
        self.started_at_epoch_ms = int(time.time() * 1000)
        os.environ[RUNTIME_ENV] = self.session_id
        self._write({
            "state": "starting",
            "runtimeSessionId": self.session_id,
            "workerPid": self.worker_pid,
            "profileDir": str(self.profile_dir),
            "startedAtEpochMs": self.started_at_epoch_ms,
        })

    @classmethod
    def create(cls, profile_dir: str | Path, requested_id: str | None = None) -> "BrowserRuntimeIdentity":
        return cls(profile_dir, requested_id)

    @property
    def marker_arg(self) -> str:
        return f"{RUNTIME_ARG_PREFIX}{self.session_id}"

    def browser_args(self, values: Iterable[str] | None = None) -> List[str]:
        args = [str(value).strip() for value in (values or []) if str(value).strip()]
        args = [value for value in args if not value.startswith(RUNTIME_ARG_PREFIX)]
        args.append(self.marker_arg)
        return args

    def browser_pids(self) -> List[int]:
        direct_matches: List[int] = []
        inherited_matches: List[int] = []
        for process in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                name = str(process.info.get("name") or "").lower()
                if not any(marker in name for marker in _BROWSER_NAME_MARKERS):
                    continue
                command_line = [str(value) for value in (process.info.get("cmdline") or [])]
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.Error):
                continue

            # The top-level Chromium process carries the explicit ARES switch.
            # Keep those direct matches first so shutdown waits on the browser
            # owner before renderer/network-service descendants.
            if self.marker_arg in command_line:
                direct_matches.append(int(process.pid))
                continue

            # Chromium child processes inherit the worker environment even when
            # they do not repeat every browser switch. This lets ARES recover the
            # exact process family after parent/child relationships change.
            try:
                environment = process.environ()
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.Error, NotImplementedError):
                environment = {}
            if str(environment.get(RUNTIME_ENV) or "") == self.session_id:
                inherited_matches.append(int(process.pid))
        return list(dict.fromkeys([*direct_matches, *inherited_matches]))

    def capture_owned_pids(self, adapter: Any) -> List[int]:
        matches = self.browser_pids()
        chrome_pid = getattr(adapter, "chrome_pid", None)
        if isinstance(chrome_pid, int) and chrome_pid > 0:
            matches = [pid for pid in matches if pid != chrome_pid]
            matches.insert(0, chrome_pid)
        if matches:
            return matches
        fallback = getattr(adapter, "_profile_browser_pids", None)
        if callable(fallback):
            try:
                return list(dict.fromkeys(int(pid) for pid in fallback() if int(pid) > 0))
            except Exception:
                pass
        return []

    def cdp_port(self, adapter: Any) -> int | None:
        sb = getattr(adapter, "_sb", None)
        getter = getattr(sb, "get_rd_port", None)
        if callable(getter):
            try:
                value = int(getter())
                if 0 < value <= 65535:
                    return value
            except Exception:
                pass

        for pid in self.capture_owned_pids(adapter):
            try:
                command_line = [str(value) for value in psutil.Process(pid).cmdline()]
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.Error):
                continue
            for argument in command_line:
                if not argument.startswith(DEBUG_PORT_PREFIX):
                    continue
                try:
                    value = int(argument.split("=", 1)[1])
                except (IndexError, ValueError):
                    continue
                if 0 < value <= 65535:
                    return value
        return None

    def ready_metadata(self, adapter: Any, startup_ms: int | float | None = None) -> Dict[str, Any]:
        browser_pid = getattr(adapter, "chrome_pid", None)
        metadata: Dict[str, Any] = {
            "state": "ready",
            "runtimeSessionId": self.session_id,
            "workerPid": self.worker_pid,
            "browserPid": int(browser_pid) if isinstance(browser_pid, int) and browser_pid > 0 else None,
            "cdpHost": "127.0.0.1",
            "cdpPort": self.cdp_port(adapter),
            "profileDir": str(self.profile_dir),
            "startedAtEpochMs": self.started_at_epoch_ms,
        }
        if startup_ms is not None:
            metadata["startupMs"] = max(0, int(startup_ms))
        self._write(metadata)
        return metadata

    def clear(self) -> None:
        target = self.profile_dir / RUNTIME_FILENAME
        try:
            raw = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if str(raw.get("runtimeSessionId") or "") != self.session_id:
            return
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass

    def _write(self, payload: Dict[str, Any]) -> None:
        target = self.profile_dir / RUNTIME_FILENAME
        temporary = self.profile_dir / f"{RUNTIME_FILENAME}.{self.session_id}.tmp"
        try:
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            temporary.replace(target)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
