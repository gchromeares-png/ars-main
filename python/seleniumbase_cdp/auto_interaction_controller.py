from __future__ import annotations

import re
import time
from typing import Any, Dict


_ACTION_TERMS = re.compile(
    r"(?i)(select|click|choose|mark|verify|verification|drag|slide|move|hold|"
    r"wähl|klick|markier|prüf|bestät|zieh|schieb|regler|bewegen|gedrückt)"
)


class AutoInteractionController:
    """Coordinate structural detection, vision decisions, and SeleniumBase actions."""

    def __init__(
        self,
        grid_adapter: Any,
        slider_adapter: Any,
        grid_actions: Any,
        slider_actions: Any,
        vision: Any,
    ) -> None:
        self._grid_adapter = grid_adapter
        self._slider_adapter = slider_adapter
        self._grid_actions = grid_actions
        self._slider_actions = slider_actions
        self._vision = vision
        self._last_grid_signature = ""
        self._last_slider_signature = ""
        self._last_action_at = 0.0

    def poll_and_act(self) -> Dict[str, Any]:
        grid = self._grid_adapter.poll()
        slider = self._slider_adapter.poll()
        candidate = grid if int(grid.get("score") or 0) >= int(slider.get("score") or 0) else slider
        if candidate.get("kind") == "image-grid":
            return self._handle_grid(candidate)
        if candidate.get("kind") == "slider":
            return self._handle_slider(candidate)
        return {"acted": False, "kind": "none", "state": candidate}

    def status(self) -> Dict[str, Any]:
        return {
            "enabled": True,
            "vision": self._vision.status(),
            "gridSignature": self._last_grid_signature,
            "sliderSignature": self._last_slider_signature,
        }

    def _handle_grid(self, state: Dict[str, Any]) -> Dict[str, Any]:
        signature = str(state.get("signature") or "")
        if not self._actionable(state) or not signature or signature == self._last_grid_signature:
            return {"acted": False, "kind": "image-grid", "state": state}
        decision = self._vision.classify(str(state.get("instruction") or ""), state.get("sources") or [])
        selected = decision.get("selectedIndexes") or []
        if not selected:
            return {"acted": False, "kind": "image-grid", "state": state, "decision": decision}
        self._last_grid_signature = signature
        self._last_action_at = time.monotonic()
        result = self._grid_actions.apply(selected, submit=True)
        return {"acted": True, "kind": "image-grid", "decision": decision, "result": result}

    def _handle_slider(self, state: Dict[str, Any]) -> Dict[str, Any]:
        signature = str(state.get("signature") or "")
        if not self._actionable(state) or not signature or signature == self._last_slider_signature:
            return {"acted": False, "kind": "slider", "state": state}
        if float(state.get("fraction") or 0) >= 0.94:
            self._last_slider_signature = signature
            return {"acted": False, "kind": "slider", "state": state}
        self._last_slider_signature = signature
        self._last_action_at = time.monotonic()
        result = self._slider_actions.apply(0.96)
        return {"acted": bool(result.get("moved")), "kind": "slider", "result": result}

    @staticmethod
    def _actionable(state: Dict[str, Any]) -> bool:
        if bool(state.get("override")):
            return True
        instruction = str(state.get("instruction") or "")
        score = int(state.get("score") or 0)
        return score >= 70 and bool(_ACTION_TERMS.search(instruction))
