from __future__ import annotations

import asyncio
import time
from typing import Any, Iterable

import task_browser_worker as base_worker
from oopif_session_runtime import OopifSessionRuntime


class EventPumpingOopifSessionRuntime(OopifSessionRuntime):
    """Let SeleniumBase process attach/detach callbacks while routing waits."""

    def _wait_for_frame_session(self, root_id: str, frame_id: str, timeout: float) -> str | None:
        if not frame_id:
            return None
        deadline = time.monotonic() + max(0.0, float(timeout))
        loop = self.sb.get_event_loop()
        while True:
            session_id = self._frame_sessions.get((root_id, frame_id))
            if session_id:
                record = self._sessions.get((root_id, session_id))
                if record and record.ready:
                    return session_id
            if time.monotonic() >= deadline:
                return None
            # SeleniumBase owns one asyncio loop for the CDP listener. Sleeping
            # only the caller thread here would starve AttachedToTarget handlers.
            loop.run_until_complete(asyncio.sleep(0.02))


class OopifTaskRpcRuntime(base_worker.TaskRpcRuntime):
    """Task RPC runtime with fail-closed OOPIF routing layered on Pure CDP."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._oopif_runtime = EventPumpingOopifSessionRuntime(self.sb)

    def _sync_newest_target(self) -> None:
        super()._sync_newest_target()
        self._oopif_runtime.ensure_tracking()

    def _execute_script_in_frame_path(
        self,
        frame_path: Iterable[str],
        script: str,
        args: Iterable[Any],
    ) -> Any:
        path = [str(value) for value in frame_path if str(value)]
        try:
            return super()._execute_script_in_frame_path(path, script, args)
        except RuntimeError as exc:
            message = str(exc).lower()
            if not path or "oopif cdp session is required" not in message:
                raise
            return self._oopif_runtime.evaluate_path(path, script, args)

    def _frame_viewport_offset(self, frame_path: Iterable[str]) -> tuple[float, float]:
        path = [str(value) for value in frame_path if str(value)]
        if not path:
            return 0.0, 0.0
        try:
            return super()._frame_viewport_offset(path)
        except RuntimeError as exc:
            message = str(exc).lower()
            if "oopif cdp session is required" not in message:
                raise
            return self._oopif_runtime.frame_viewport_offset(path)


# base_worker.run() resolves TaskRpcRuntime from its own module globals.
# Replace only that neutral RPC runtime symbol; challenge/solver code remains untouched.
base_worker.TaskRpcRuntime = OopifTaskRpcRuntime


if __name__ == "__main__":
    raise SystemExit(base_worker.main())
