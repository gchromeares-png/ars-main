from __future__ import annotations

import re
import time
from typing import Any, Dict


_ACTION_TERMS = re.compile(
    r"(?i)(select|click|choose|mark|verify|verification|drag|slide|move|hold|"
    r"wähl|klick|markier|prüf|bestät|zieh|schieb|regler|bewegen|gedrückt)"
)


class AutoInteractionController:
    """Coordinate observation, grounding, actions, and passive re-evaluation."""

    def __init__(
        self,
        grid_adapter: Any,
        slider_adapter: Any,
        grid_actions: Any,
        slider_actions: Any,
        vision: Any,
        slider_grounder: Any = None,
        trace: Any = None,
    ) -> None:
        self._grid_adapter = grid_adapter
        self._slider_adapter = slider_adapter
        self._grid_actions = grid_actions
        self._slider_actions = slider_actions
        self._vision = vision
        self._slider_grounder = slider_grounder
        self._trace = trace
        self._last_grid_signature = ""
        self._last_slider_signature = ""
        self._last_action_at = 0.0

    def poll_and_act(self) -> Dict[str, Any]:
        grid = self._grid_adapter.poll()
        slider = self._slider_adapter.poll()
        candidate = grid if int(grid.get("score") or 0) >= int(slider.get("score") or 0) else slider
        self._record("observation", {"kind": candidate.get("kind"), "state": candidate})
        if candidate.get("kind") == "image-grid":
            return self._handle_grid(candidate)
        if candidate.get("kind") == "slider":
            return self._handle_slider(candidate)
        return {"acted": False, "kind": "none", "state": candidate}

    def status(self) -> Dict[str, Any]:
        status = {
            "enabled": True,
            "vision": self._vision.status(),
            "gridSignature": self._last_grid_signature,
            "sliderSignature": self._last_slider_signature,
        }
        trace_path = getattr(self._trace, "path", None)
        if trace_path:
            status["tracePath"] = str(trace_path)
        return status

    def _handle_grid(self, state: Dict[str, Any]) -> Dict[str, Any]:
        signature = str(state.get("signature") or "")
        if not self._actionable(state) or not signature or signature == self._last_grid_signature:
            return {"acted": False, "kind": "image-grid", "state": state}

        decision = self._vision.classify(str(state.get("instruction") or ""), state.get("sources") or [])
        selected = self._selected_indexes(decision.get("selectedIndexes") or [], int(state.get("tileCount") or 0))
        tile_marks = [
            mark for mark in state.get("marks") or []
            if isinstance(mark, dict) and mark.get("role") == "grid-tile"
        ]
        selected_mark_ids = [
            str(tile_marks[index].get("markId") or "")
            for index in selected
            if index < len(tile_marks) and tile_marks[index].get("markId")
        ]
        decision = {**decision, "selectedIndexes": selected, "selectedMarkIds": selected_mark_ids}
        self._record("decision", {"kind": "image-grid", "decision": decision})
        if not selected:
            return {"acted": False, "kind": "image-grid", "state": state, "decision": decision}

        self._last_action_at = time.monotonic()
        apply_marks = getattr(self._grid_actions, "apply_marks", None)
        if selected_mark_ids and callable(apply_marks):
            result = apply_marks(selected_mark_ids, submit=True)
        else:
            result = self._grid_actions.apply(selected, submit=True)

        clicked = result.get("clickedIndexes") if isinstance(result, dict) else []
        if not clicked:
            self._record("action", {"kind": "image-grid", "decision": decision, "result": result, "verification": {"verified": False, "reason": "no-click-resolved"}})
            return {
                "acted": False,
                "verified": False,
                "kind": "image-grid",
                "decision": decision,
                "result": result,
                "verification": {"verified": False, "reason": "no-click-resolved"},
            }

        self._last_grid_signature = signature
        verification = self._verify_grid(signature, result.get("state") if isinstance(result, dict) else None)
        self._record("action", {"kind": "image-grid", "decision": decision, "result": result, "verification": verification})
        return {
            "acted": True,
            "verified": bool(verification.get("verified")),
            "kind": "image-grid",
            "decision": decision,
            "result": result,
            "verification": verification,
        }

    def _handle_slider(self, state: Dict[str, Any]) -> Dict[str, Any]:
        signature = str(state.get("signature") or "")
        if bool(state.get("complete")):
            self._last_slider_signature = signature or self._last_slider_signature
            return {"acted": False, "verified": True, "kind": "slider", "state": state, "reason": "complete"}
        if bool(state.get("failed")):
            self._last_slider_signature = signature or self._last_slider_signature
            return {"acted": False, "verified": False, "kind": "slider", "state": state, "reason": "failed"}
        if not self._actionable(state) or not signature or signature == self._last_slider_signature:
            return {"acted": False, "kind": "slider", "state": state}

        target = self._ground_slider(state)
        self._record("decision", {"kind": "slider", "target": target, "state": state})
        if not bool(target.get("grounded")) or float(target.get("confidence") or 0.0) < 0.40:
            return {"acted": False, "kind": "slider", "state": state, "target": target}

        target_fraction = float(target.get("targetFraction"))
        self._last_action_at = time.monotonic()
        result = self._slider_actions.apply(target_fraction, state=state)
        verification = self._verify_slider(state, target_fraction, result.get("state") if isinstance(result, dict) else None)
        fallback = None

        if bool(result.get("moved")) and not bool(verification.get("verified")):
            latest = verification.get("state") if isinstance(verification.get("state"), dict) else self._slider_adapter.poll()
            if latest.get("kind") == "slider" and not latest.get("complete") and not latest.get("failed"):
                fallback = self._slider_actions.apply(target_fraction, state=latest, force_fallback=True)
                verification = self._verify_slider(latest, target_fraction, fallback.get("state") if isinstance(fallback, dict) else None)

        acted = bool(result.get("moved")) or bool((fallback or {}).get("moved"))
        if acted:
            self._last_slider_signature = signature
        payload = {
            "acted": acted,
            "verified": bool(verification.get("verified")),
            "kind": "slider",
            "target": target,
            "result": result,
            "verification": verification,
        }
        if fallback is not None:
            payload["fallback"] = fallback
        self._record("action", payload)
        return payload

    def _ground_slider(self, state: Dict[str, Any]) -> Dict[str, Any]:
        if self._slider_grounder is not None:
            try:
                return self._slider_grounder.ground(state)
            except Exception as exc:
                return {"grounded": False, "targetFraction": None, "confidence": 0.0, "source": "error", "error": str(exc)}
        return {"grounded": True, "targetFraction": 0.96, "confidence": 0.40, "source": "legacy-directional", "markId": "fallback"}

    def _verify_grid(self, before_signature: str, initial: Any) -> Dict[str, Any]:
        state = initial if isinstance(initial, dict) else self._grid_adapter.poll()
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if state.get("kind") != "image-grid":
                return {"verified": True, "reason": "grid-cleared", "state": state}
            signature = str(state.get("signature") or "")
            if signature and signature != before_signature:
                return {"verified": True, "reason": "grid-changed", "state": state}
            time.sleep(0.06)
            state = self._grid_adapter.poll()
        return {"verified": False, "reason": "no-observed-change", "state": state}

    def _verify_slider(self, before: Dict[str, Any], target: float, initial: Any) -> Dict[str, Any]:
        before_fraction = float(before.get("fraction") or 0.0)
        before_distance = abs(before_fraction - target)
        state = initial if isinstance(initial, dict) else self._slider_adapter.poll()
        deadline = time.monotonic() + 1.25
        while time.monotonic() < deadline:
            if state.get("kind") != "slider":
                return {"verified": True, "reason": "slider-cleared", "state": state}
            if bool(state.get("complete")):
                return {"verified": True, "reason": "complete-state", "state": state}
            if bool(state.get("failed")):
                return {"verified": False, "reason": "failed-state", "state": state}
            current = float(state.get("fraction") or 0.0)
            current_distance = abs(current - target)
            movement = abs(current - before_fraction)
            tolerance = max(0.025, min(0.08, before_distance * 0.18))
            if current_distance <= tolerance:
                return {"verified": True, "reason": "target-reached", "distance": current_distance, "state": state}
            if movement >= 0.02 and current_distance < before_distance * 0.45:
                return {"verified": True, "reason": "target-approached", "distance": current_distance, "state": state}
            time.sleep(0.06)
            state = self._slider_adapter.poll()
        return {"verified": False, "reason": "no-confirmed-target-change", "state": state}

    def _record(self, phase: str, payload: Dict[str, Any]) -> None:
        if self._trace is None:
            return
        try:
            self._trace.append(phase, payload)
        except Exception:
            pass

    @staticmethod
    def _selected_indexes(values: Any, count: int) -> list[int]:
        selected = set()
        for value in values:
            try:
                index = int(value)
            except (TypeError, ValueError):
                continue
            if 0 <= index < count:
                selected.add(index)
        return sorted(selected)

    @staticmethod
    def _actionable(state: Dict[str, Any]) -> bool:
        if bool(state.get("override")):
            return True
        instruction = str(state.get("instruction") or "")
        score = int(state.get("score") or 0)
        return score >= 70 and bool(_ACTION_TERMS.search(instruction))
