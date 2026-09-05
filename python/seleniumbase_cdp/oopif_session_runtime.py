from __future__ import annotations

import asyncio
import itertools
import json
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List

import mycdp


FLAT_SESSION_REQUEST_ID_START = 10_000_000
_SESSION_RETRY_ERRORS = (
    "execution context was destroyed",
    "cannot find context",
    "inspected target navigated or closed",
    "target closed",
    "session with given id not found",
    "no frame with given id",
)


@dataclass
class _SessionRecord:
    session_id: str
    target_id: str
    frame_id: str
    parent_frame_id: str
    ready: bool = False


class _FlatPending:
    """Small future bridge that coexists with SeleniumBase's Connection.mapper."""

    def __init__(self, future: asyncio.Future, session_id: str | None) -> None:
        self.future = future
        self.session_id = session_id

    def __call__(self, **response: Any) -> None:
        if self.future.done():
            return
        actual_session = str(response.get("sessionId") or "") or None
        if self.session_id and actual_session and actual_session != self.session_id:
            self.future.set_exception(
                RuntimeError(
                    f"Flat CDP response session mismatch: expected {self.session_id}, got {actual_session}"
                )
            )
            return
        if "error" in response:
            error = response.get("error") or {}
            if isinstance(error, dict):
                message = str(error.get("message") or error)
            else:
                message = str(error)
            self.future.set_exception(RuntimeError(message))
            return
        self.future.set_result(response.get("result") or {})

    def __repr__(self) -> str:
        return f"<_FlatPending session={self.session_id or 'root'}>"


class OopifSessionRuntime:
    """Flat-CDP routing for cross-origin iframe targets.

    SeleniumBase 4.53.7 exposes the root/tab Connection but no high-level
    child-session wrapper. This class intentionally shares that one websocket
    and its response mapper while reserving a separate request-id namespace.
    Child sessions are keyed by sessionId for lifecycle and frameId only as the
    current routing pointer, so an old RFH detach cannot delete a newer session.
    """

    def __init__(self, sb: Any) -> None:
        self.sb = sb
        self._ids = itertools.count(FLAT_SESSION_REQUEST_ID_START)
        self._configured_roots: set[str] = set()
        self._sessions: Dict[tuple[str, str], _SessionRecord] = {}
        self._frame_sessions: Dict[tuple[str, str], str] = {}
        self._last_error = ""
        self.ensure_tracking()

    def ensure_tracking(self) -> None:
        try:
            connection = self.sb.get_active_tab()
        except Exception:
            return
        root_id = self._root_id(connection)
        if root_id in self._configured_roots:
            return

        # Register handlers before setAutoAttach so existing related OOPIFs
        # cannot race past the registry during initial attachment.
        connection.add_handler(mycdp.target.AttachedToTarget, self._on_attached)
        connection.add_handler(mycdp.target.DetachedFromTarget, self._on_detached)
        loop = self.sb.get_event_loop()
        loop.run_until_complete(self._configure_root(connection))
        self._configured_roots.add(root_id)

    async def _configure_root(self, connection: Any) -> None:
        # DOM/Runtime are connection-local domains. Explicitly enable both on
        # the root as well because route resolution uses DOM.requestNode.
        await self._send_async(connection, None, "DOM.enable", {})
        await self._send_async(connection, None, "Runtime.enable", {})
        await self._send_async(
            connection,
            None,
            "Target.setAutoAttach",
            {
                "autoAttach": True,
                "waitForDebuggerOnStart": False,
                "flatten": True,
            },
        )

    async def _on_attached(self, event: Any, connection: Any = None) -> None:
        # Event callbacks must never tear down SeleniumBase's listener task.
        try:
            if connection is None:
                connection = self.sb.get_active_tab()
            root_id = self._root_id(connection)
            session_id = str(getattr(event, "session_id", "") or "")
            target_info = getattr(event, "target_info", None)
            target_type = str(getattr(target_info, "type_", "") or "")
            if not session_id or target_type != "iframe":
                return

            target_id = str(getattr(target_info, "target_id", "") or "")
            parent_frame_id = str(getattr(target_info, "parent_frame_id", "") or "")
            record = _SessionRecord(
                session_id=session_id,
                target_id=target_id,
                frame_id=target_id,
                parent_frame_id=parent_frame_id,
                ready=False,
            )
            self._sessions[(root_id, session_id)] = record

            # Chromium does not inherit enabled domains into child targets.
            # Enable these immediately, before any child DOM work.
            await self._send_async(connection, session_id, "DOM.enable", {})
            await self._send_async(connection, session_id, "Runtime.enable", {})

            # Auto-attach is not recursive by itself. Apply it to each attached
            # iframe so nested OOPIFs are surfaced on the same flattened socket.
            await self._send_async(
                connection,
                session_id,
                "Target.setAutoAttach",
                {
                    "autoAttach": True,
                    "waitForDebuggerOnStart": False,
                    "flatten": True,
                },
            )

            frame_id = target_id
            try:
                frame_tree = await self._send_async(connection, session_id, "Page.getFrameTree", {})
                frame_id = str(
                    (((frame_tree.get("frameTree") or {}).get("frame") or {}).get("id"))
                    or target_id
                )
            except Exception:
                # For OOPIF targets Chromium currently uses the frame target id
                # as the frame id. Keep it only as a fallback if Page is racing.
                frame_id = target_id

            record.frame_id = frame_id
            record.ready = True
            if frame_id:
                # New attach wins. A later detach for an older RenderFrameHost
                # may only remove the pointer if it still points at that exact
                # old session id.
                self._frame_sessions[(root_id, frame_id)] = session_id
            self._last_error = ""
        except Exception as exc:
            self._last_error = str(exc)

    async def _on_detached(self, event: Any, connection: Any = None) -> None:
        try:
            if connection is None:
                connection = self.sb.get_active_tab()
            root_id = self._root_id(connection)
            session_id = str(getattr(event, "session_id", "") or "")
            if not session_id:
                return
            record = self._sessions.pop((root_id, session_id), None)
            if not record or not record.frame_id:
                return
            key = (root_id, record.frame_id)
            if self._frame_sessions.get(key) == session_id:
                self._frame_sessions.pop(key, None)
        except Exception as exc:
            self._last_error = str(exc)

    async def _send_async(
        self,
        connection: Any,
        session_id: str | None,
        method: str,
        params: Dict[str, Any] | None = None,
        timeout: float = 5.0,
    ) -> Dict[str, Any]:
        await connection.aopen()
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        request_id = next(self._ids)
        pending = _FlatPending(future, session_id)
        connection.mapper[request_id] = pending
        payload: Dict[str, Any] = {
            "id": request_id,
            "method": str(method),
            "params": dict(params or {}),
        }
        if session_id:
            payload["sessionId"] = session_id
        try:
            await connection.websocket.send(json.dumps(payload, separators=(",", ":")))
            return await asyncio.wait_for(future, timeout=max(0.25, float(timeout)))
        finally:
            if connection.mapper.get(request_id) is pending:
                connection.mapper.pop(request_id, None)

    def _send(
        self,
        connection: Any,
        session_id: str | None,
        method: str,
        params: Dict[str, Any] | None = None,
        timeout: float = 5.0,
    ) -> Dict[str, Any]:
        loop = self.sb.get_event_loop()
        return loop.run_until_complete(
            self._send_async(connection, session_id, method, params, timeout)
        )

    def evaluate_path(self, frame_path: Iterable[str], script: str, args: Iterable[Any]) -> Any:
        path = [str(value) for value in frame_path if str(value)]
        if not path:
            raise ValueError("OOPIF path routing requires at least one frame")
        last: Exception | None = None
        for attempt in range(3):
            try:
                self.ensure_tracking()
                connection, session_id, local_path = self._resolve_route(path)
                expression = self._script_expression(local_path, script, list(args))
                return self._runtime_value(connection, session_id, expression)
            except Exception as exc:
                last = exc
                if not self._is_retryable(exc) or attempt >= 2:
                    raise
                time.sleep(0.08 * (attempt + 1))
                self.ensure_tracking()
        if last:
            raise last
        return None

    def frame_viewport_offset(self, frame_path: Iterable[str]) -> tuple[float, float]:
        path = [str(value) for value in frame_path if str(value)]
        if not path:
            return 0.0, 0.0
        last: Exception | None = None
        for attempt in range(3):
            try:
                return self._frame_viewport_offset_once(path)
            except Exception as exc:
                last = exc
                if not self._is_retryable(exc) or attempt >= 2:
                    raise
                time.sleep(0.08 * (attempt + 1))
        if last:
            raise last
        return 0.0, 0.0

    def _frame_viewport_offset_once(self, path: List[str]) -> tuple[float, float]:
        self.ensure_tracking()
        connection = self.sb.get_active_tab()
        root_id = self._root_id(connection)
        session_id: str | None = None
        local_path: List[str] = []
        total_x = 0.0
        total_y = 0.0

        for selector in path:
            box = self._frame_box(connection, session_id, local_path, selector)
            if not box.get("visible"):
                raise LookupError(f"Frame is not visible for native click: {selector}")
            total_x += float(box.get("x") or 0.0) + float(box.get("clientLeft") or 0.0)
            total_y += float(box.get("y") or 0.0) + float(box.get("clientTop") or 0.0)

            frame_id = self._frame_id_for_selector(connection, session_id, local_path, selector)
            routed = self._wait_for_frame_session(root_id, frame_id, timeout=0.20)
            if routed:
                session_id = routed
                local_path = []
                continue

            candidate = [*local_path, selector]
            if self._frame_document_accessible(connection, session_id, candidate):
                local_path = candidate
                continue

            routed = self._wait_for_frame_session(root_id, frame_id, timeout=0.75)
            if routed:
                session_id = routed
                local_path = []
                continue
            raise RuntimeError(
                f"Cross-origin frame {selector!r} has no ready flattened OOPIF session"
            )

        return total_x, total_y

    def _resolve_route(self, path: List[str]) -> tuple[Any, str | None, List[str]]:
        connection = self.sb.get_active_tab()
        root_id = self._root_id(connection)
        session_id: str | None = None
        local_path: List[str] = []

        for selector in path:
            frame_id = self._frame_id_for_selector(connection, session_id, local_path, selector)
            routed = self._wait_for_frame_session(root_id, frame_id, timeout=0.20)
            if routed:
                session_id = routed
                local_path = []
                continue

            candidate = [*local_path, selector]
            if self._frame_document_accessible(connection, session_id, candidate):
                local_path = candidate
                continue

            routed = self._wait_for_frame_session(root_id, frame_id, timeout=0.75)
            if routed:
                session_id = routed
                local_path = []
                continue
            raise RuntimeError(
                f"Cross-origin frame {selector!r} has no ready flattened OOPIF session"
            )

        return connection, session_id, local_path

    def _frame_id_for_selector(
        self,
        connection: Any,
        session_id: str | None,
        local_path: List[str],
        selector: str,
    ) -> str:
        expression = self._element_expression(local_path, selector)
        result = self._runtime_result(connection, session_id, expression, return_by_value=False)
        remote = result.get("result") or {}
        object_id = str(remote.get("objectId") or "")
        if not object_id:
            raise LookupError(f"Frame path no longer resolves at {selector}")
        try:
            node = self._send(
                connection,
                session_id,
                "DOM.requestNode",
                {"objectId": object_id},
            )
            node_id = node.get("nodeId")
            if node_id is None:
                raise LookupError(f"DOM.requestNode returned no node for {selector}")
            described = self._send(
                connection,
                session_id,
                "DOM.describeNode",
                {"nodeId": node_id, "depth": 1},
            )
            frame_id = str(((described.get("node") or {}).get("frameId")) or "")
            if not frame_id:
                raise LookupError(f"Iframe DOM node has no frameId: {selector}")
            return frame_id
        finally:
            try:
                self._send(
                    connection,
                    session_id,
                    "Runtime.releaseObject",
                    {"objectId": object_id},
                    timeout=2.0,
                )
            except Exception:
                pass

    def _frame_box(
        self,
        connection: Any,
        session_id: str | None,
        local_path: List[str],
        selector: str,
    ) -> Dict[str, Any]:
        expression = f"""
(() => {{
  const path = {json.dumps(local_path, ensure_ascii=False)};
  const selector = {json.dumps(selector, ensure_ascii=False)};
  let targetWindow = window;
  for (const part of path) {{
    const frame = targetWindow.document.querySelector(part);
    if (!frame || !frame.contentWindow) return {{missing:true}};
    targetWindow = frame.contentWindow;
  }}
  const frame = targetWindow.document.querySelector(selector);
  if (!frame) return {{missing:true}};
  frame.scrollIntoView({{block:'nearest', inline:'nearest'}});
  const r = frame.getBoundingClientRect();
  return {{
    x:r.left, y:r.top, width:r.width, height:r.height,
    clientLeft:Number(frame.clientLeft || 0), clientTop:Number(frame.clientTop || 0),
    visible:r.width > 0 && r.height > 0
  }};
}})()
"""
        value = self._runtime_value(connection, session_id, expression)
        if not isinstance(value, dict) or value.get("missing"):
            raise LookupError(f"Frame path no longer resolves at {selector}")
        return value

    def _frame_document_accessible(
        self,
        connection: Any,
        session_id: str | None,
        local_path: List[str],
    ) -> bool:
        expression = f"""
(() => {{
  const path = {json.dumps(local_path, ensure_ascii=False)};
  try {{
    let targetWindow = window;
    for (const selector of path) {{
      const frame = targetWindow.document.querySelector(selector);
      if (!frame || !frame.contentWindow) return false;
      targetWindow = frame.contentWindow;
    }}
    return !!targetWindow.document.documentElement;
  }} catch (_) {{
    return false;
  }}
}})()
"""
        try:
            return bool(self._runtime_value(connection, session_id, expression))
        except Exception:
            return False

    def _runtime_result(
        self,
        connection: Any,
        session_id: str | None,
        expression: str,
        *,
        return_by_value: bool,
    ) -> Dict[str, Any]:
        result = self._send(
            connection,
            session_id,
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": bool(return_by_value),
                "awaitPromise": True,
                "userGesture": False,
            },
        )
        exception = result.get("exceptionDetails")
        if exception:
            text = str((exception or {}).get("text") or exception)
            raise RuntimeError(text)
        return result

    def _runtime_value(self, connection: Any, session_id: str | None, expression: str) -> Any:
        result = self._runtime_result(connection, session_id, expression, return_by_value=True)
        remote = result.get("result") or {}
        if remote.get("subtype") == "error":
            raise RuntimeError(str(remote.get("description") or "Runtime.evaluate failed"))
        return remote.get("value")

    def _wait_for_frame_session(self, root_id: str, frame_id: str, timeout: float) -> str | None:
        if not frame_id:
            return None
        deadline = time.monotonic() + max(0.0, float(timeout))
        while True:
            session_id = self._frame_sessions.get((root_id, frame_id))
            if session_id:
                record = self._sessions.get((root_id, session_id))
                if record and record.ready:
                    return session_id
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.02)

    @staticmethod
    def _root_id(connection: Any) -> str:
        value = str(getattr(connection, "target_id", "") or "")
        return value or f"connection:{id(connection)}"

    @staticmethod
    def _is_retryable(error: Exception) -> bool:
        message = str(error).lower()
        return any(marker in message for marker in _SESSION_RETRY_ERRORS)

    @staticmethod
    def _element_expression(local_path: List[str], selector: str) -> str:
        return f"""
(() => {{
  const path = {json.dumps(local_path, ensure_ascii=False)};
  const selector = {json.dumps(selector, ensure_ascii=False)};
  let targetWindow = window;
  for (const part of path) {{
    const frame = targetWindow.document.querySelector(part);
    if (!frame || !frame.contentWindow) return null;
    targetWindow = frame.contentWindow;
  }}
  return targetWindow.document.querySelector(selector);
}})()
"""

    @staticmethod
    def _script_expression(local_path: List[str], source: str, args: List[Any]) -> str:
        return f"""
(() => {{
  const path = {json.dumps(local_path, ensure_ascii=False)};
  const source = {json.dumps(str(source or ''), ensure_ascii=False)};
  const callArgs = {json.dumps(args, ensure_ascii=False, separators=(',', ':'))};
  let targetWindow = window;
  for (const selector of path) {{
    const frame = targetWindow.document.querySelector(selector);
    if (!frame || !frame.contentWindow) return {{__aresFrameMissing:true, selector}};
    targetWindow = frame.contentWindow;
  }}
  try {{
    const fn = targetWindow.Function(source);
    return fn.apply(targetWindow, callArgs);
  }} catch (error) {{
    return {{__aresFrameExecutionError:true, message:String(error?.message || error)}};
  }}
}})()
"""
