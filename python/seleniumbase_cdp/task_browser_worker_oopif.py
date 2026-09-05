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


impl.FlatCdpTargetRegistry._child_frame_id = _child_frame_id

FlatCdpTargetRegistry = impl.FlatCdpTargetRegistry
main = impl.main


if __name__ == "__main__":
    raise SystemExit(main())
