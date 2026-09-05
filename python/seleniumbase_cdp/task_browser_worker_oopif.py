from __future__ import annotations

from typing import Any

import task_browser_worker_oopif_impl as impl


def _child_frame_id(self: Any, frame_id: str, selector: str) -> str:
    """Resolve a frame owner without creating a transient frontend nodeId.

    Runtime objectIds and DOM frontend nodeIds are session-scoped and may become
    stale independently during RFH/DOM transitions. Keep the object and DOM
    lookup on the same live route, and let DOM.describeNode consume the objectId
    directly so no ephemeral nodeId crosses commands.
    """
    selector_json = impl.json.dumps(str(selector), ensure_ascii=False)
    last: BaseException | None = None
    for attempt in range(3):
        route = self._wait_for_route(frame_id, timeout=1.5)
        session_id = str(route["sessionId"])
        try:
            response = self.call(
                "Runtime.evaluate",
                {
                    "expression": f"document.querySelector({selector_json})",
                    "contextId": int(route["contextId"]),
                    "returnByValue": False,
                    "awaitPromise": True,
                },
                session_id=session_id,
            )
            if response.get("exceptionDetails"):
                raise RuntimeError(f"Runtime.evaluate failed: {response.get('exceptionDetails')}")
            remote = response.get("result") if isinstance(response.get("result"), dict) else {}
            object_id = str(remote.get("objectId") or "")
            if not object_id:
                raise LookupError(f"Frame path no longer resolves at {selector}")
            try:
                description = self.call(
                    "DOM.describeNode",
                    {"objectId": object_id, "depth": 0, "pierce": True},
                    session_id=session_id,
                )
                node = description.get("node") if isinstance(description.get("node"), dict) else {}
                child_frame_id = str(node.get("frameId") or "")
                if not child_frame_id:
                    raise LookupError(f"CDP frameId is unavailable at {selector}")
                self._wait_for_route(child_frame_id, timeout=2.0)
                return child_frame_id
            finally:
                try:
                    self.call("Runtime.releaseObject", {"objectId": object_id}, session_id=session_id, timeout=1.0)
                except Exception:
                    pass
        except BaseException as exc:
            last = exc
            text = str(exc).lower()
            stale = (
                "could not find node" in text
                or "cannot find context" in text
                or "execution context was destroyed" in text
                or "inspected target navigated or closed" in text
                or "no frame with given id" in text
            )
            if not stale or attempt >= 2:
                raise
            impl.time.sleep(0.03 * (attempt + 1))
    if last is not None:
        raise last
    raise RuntimeError("Frame owner resolution failed without an error")


def _left_button(runtime: Any) -> Any:
    input_domain = getattr(impl.base.mycdp, "input_", None)
    mouse_button = getattr(input_domain, "MouseButton", None)
    left = getattr(mouse_button, "LEFT", None)
    if left is None:
        raise RuntimeError("CDP left mouse button enum is unavailable")
    return left


def _pointer_mouse(self: Any, action: str, command: dict[str, Any]) -> bool:
    """Drive generic pointer actions through the existing top-level CDP input.

    Coordinates are viewport coordinates. The pressed state is kept only so
    mouseMoved carries the correct CDP buttons bitmask while a drag is active.
    """
    if action in {"mouse-move", "mouse-click"}:
        x = float(command.get("x") or 0)
        y = float(command.get("y") or 0)
        self._pointer_x = x
        self._pointer_y = y
    else:
        x = float(getattr(self, "_pointer_x", 0.0))
        y = float(getattr(self, "_pointer_y", 0.0))

    if action != "mouse-up":
        hit = self._execute_script_retry_for_path(
            [],
            "return !!document.elementFromPoint(Number(arguments[0]), Number(arguments[1]));",
            x,
            y,
        )
        if not hit:
            return False

    if action == "mouse-move":
        self._dispatch_mouse_event(
            "mouseMoved",
            x,
            y,
            buttons=1 if bool(getattr(self, "_pointer_pressed", False)) else 0,
        )
        return True
    if action == "mouse-down":
        self._dispatch_mouse_event("mousePressed", x, y, button=_left_button(self), buttons=1, click_count=1)
        self._pointer_pressed = True
        return True
    if action == "mouse-up":
        try:
            self._dispatch_mouse_event("mouseReleased", x, y, button=_left_button(self), buttons=0, click_count=1)
        finally:
            self._pointer_pressed = False
        return True
    if action == "mouse-click":
        self._dispatch_native_click(x, y)
        self._sync_newest_target()
        return True
    raise ValueError(f"Unsupported pointer action: {action!r}")


_original_rpc = impl.base.TaskRpcRuntime.rpc


def _pointer_rpc(self: Any, command: dict[str, Any]) -> dict[str, Any]:
    action = str(command.get("action") or "")
    if action in {"mouse-down", "mouse-up"}:
        self._sync_newest_target()
        return {"result": self._mouse(action, command)}
    return _original_rpc(self, command)


impl.FlatCdpTargetRegistry._child_frame_id = _child_frame_id
impl.base.TaskRpcRuntime._mouse = _pointer_mouse
impl.base.TaskRpcRuntime.rpc = _pointer_rpc

FlatCdpTargetRegistry = impl.FlatCdpTargetRegistry
main = impl.main


if __name__ == "__main__":
    raise SystemExit(main())
