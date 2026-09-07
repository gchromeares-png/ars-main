from __future__ import annotations

import time
from typing import Any, Dict, Iterable, List

from seleniumbase_adapter import SeleniumBaseCdpAdapter


class ControlAwareSeleniumBaseCdpAdapter(SeleniumBaseCdpAdapter):
    """Keep automatic page work behind recent explicit control-plane activity.

    SeleniumBase/CDP remains single-owner. Explicit RPC/control calls mark a short
    quiet window; idle polling skips expensive automatic visual work during that
    window so a follow-up command cannot lose a race to background inference.
    The next idle poll resumes the unchanged full runtime automatically.
    """

    CONTROL_QUIET_SECONDS = 0.9

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._control_quiet_until = 0.0
        super().__init__(*args, **kwargs)

    def note_control_activity(self) -> None:
        self._control_quiet_until = max(
            self._control_quiet_until,
            time.monotonic() + self.CONTROL_QUIET_SECONDS,
        )

    def poll_runtime(self) -> None:
        if time.monotonic() < self._control_quiet_until:
            return
        super().poll_runtime()

    def goto(self, url: str) -> None:
        self.note_control_activity()
        super().goto(url)
        self.note_control_activity()

    def challenge_state(self) -> Dict[str, Any]:
        self.note_control_activity()
        return super().challenge_state()

    def site_grid_state(self) -> Dict[str, Any]:
        self.note_control_activity()
        return super().site_grid_state()

    def site_slider_state(self) -> Dict[str, Any]:
        self.note_control_activity()
        return super().site_slider_state()

    def slider_target_state(self) -> Dict[str, Any]:
        self.note_control_activity()
        return super().slider_target_state()

    def auto_interaction_state(self) -> Dict[str, Any]:
        self.note_control_activity()
        return super().auto_interaction_state()

    def interaction_outcome_state(self) -> Dict[str, Any]:
        self.note_control_activity()
        return super().interaction_outcome_state()

    def observe_semantic_fields(self) -> List[Dict[str, Any]]:
        self.note_control_activity()
        return super().observe_semantic_fields()

    def execute_semantic_plan(self, plan: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
        self.note_control_activity()
        result = super().execute_semantic_plan(plan)
        self.note_control_activity()
        return result

    def apply_grid_selection(self, indexes: Iterable[int], *, submit: bool = True) -> Dict[str, Any]:
        self.note_control_activity()
        result = super().apply_grid_selection(indexes, submit=submit)
        self.note_control_activity()
        return result

    def apply_slider(self, target_fraction: float = 0.96) -> Dict[str, Any]:
        self.note_control_activity()
        result = super().apply_slider(target_fraction)
        self.note_control_activity()
        return result

    def inspect_session(self) -> Dict[str, Any]:
        self.note_control_activity()
        return super().inspect_session()

    def set_snapshot_cookies(self, cookies: Iterable[Dict[str, Any]]) -> int:
        self.note_control_activity()
        result = super().set_snapshot_cookies(cookies)
        self.note_control_activity()
        return result

    def get_snapshot_cookies(self) -> List[Dict[str, Any]]:
        self.note_control_activity()
        return super().get_snapshot_cookies()
