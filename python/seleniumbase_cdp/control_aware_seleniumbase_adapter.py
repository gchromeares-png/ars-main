from __future__ import annotations

import time
from typing import Any, Callable, Dict, Iterable, List

from oopif_visual_interaction_runtime import OopifVisualInteractionRuntime
from seleniumbase_adapter import SeleniumBaseCdpAdapter


class ControlAwareSeleniumBaseCdpAdapter(SeleniumBaseCdpAdapter):
    """Keep expensive automatic page work behind explicit control-plane traffic."""

    CONTROL_QUIET_SECONDS = 0.9

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._control_quiet_until = 0.0
        self._deferred_navigation_auto = False
        self._passive_observation_depth = 0
        super().__init__(*args, **kwargs)
        overrides = kwargs.get("site_adapter_overrides")
        self._visual_interactions = OopifVisualInteractionRuntime(
            self._sb,
            profile_dir=self.profile_dir,
            overrides=overrides if isinstance(overrides, dict) else {},
            capture=self._capture,
        )
        self.note_control_activity()

    def note_control_activity(self) -> None:
        if self._passive_observation_depth > 0:
            return
        self._control_quiet_until = max(
            self._control_quiet_until,
            time.monotonic() + self.CONTROL_QUIET_SECONDS,
        )

    def passive_observation(self, action: Callable[[], Any]) -> Any:
        """Run read-only telemetry without masquerading as user/control traffic."""
        self._passive_observation_depth += 1
        try:
            return action()
        finally:
            self._passive_observation_depth = max(0, self._passive_observation_depth - 1)

    def poll_runtime(self) -> None:
        if time.monotonic() < self._control_quiet_until:
            return
        if self._deferred_navigation_auto:
            self._deferred_navigation_auto = False
            self._poll_observation_watchdog(force=True)
            return
        super().poll_runtime()

    def goto(self, url: str) -> None:
        """Navigate synchronously, but defer expensive automatic visual work."""
        self.note_control_activity()
        self._sb.goto(url)
        self._challenge_tracker.wait_for_stable_challenge()
        self._sb.solve_captcha()
        self._watchdog.reset()
        initial = self._watchdog.poll()
        self._last_watchdog_state = initial
        self._capture_debug(
            "page-load",
            generation=int(initial.get("generation") or 0),
            force=True,
        )
        self._deferred_navigation_auto = True
        self.note_control_activity()

    def execute_script(self, script: str, *args: Any) -> Any:
        self.note_control_activity()
        result = super().execute_script(script, *args)
        self.note_control_activity()
        return result

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
