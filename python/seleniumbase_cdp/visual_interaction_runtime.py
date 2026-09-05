from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterable

from authorized_grid_action_executor import AuthorizedGridActionExecutor
from auto_interaction_controller import AutoInteractionController
from cursor_path_provider import CursorPathProvider
from interaction_trace import InteractionTrace
from site_grid_adapter import GridSiteAdapter
from site_slider_adapter import SliderSiteAdapter
from slider_action_executor import SliderActionExecutor
from slider_target_grounder import SliderTargetGrounder
from vision_grid_classifier import VisionGridClassifier


class VisualInteractionRuntime:
    """Single ARES observation → grounding → action → re-observation boundary."""

    def __init__(
        self,
        seleniumbase_cdp: Any,
        *,
        profile_dir: str | Path,
        overrides: Dict[str, str] | None = None,
    ) -> None:
        self._sb = seleniumbase_cdp
        self._profile_dir = Path(profile_dir).expanduser().resolve()
        self._grid = GridSiteAdapter(self._sb, overrides=overrides or {})
        self._slider = SliderSiteAdapter(self._sb, overrides=overrides or {})
        self._paths = CursorPathProvider()
        self._grid_actions = AuthorizedGridActionExecutor(self._sb, self._grid)
        self._slider_actions = SliderActionExecutor(self._sb, self._slider, self._paths)
        self._vision = VisionGridClassifier()
        self._slider_grounder = SliderTargetGrounder(self._sb, profile_dir=self._profile_dir)
        self._trace = InteractionTrace(self._profile_dir)
        self._controller = AutoInteractionController(
            self._grid,
            self._slider,
            self._grid_actions,
            self._slider_actions,
            self._vision,
            self._slider_grounder,
            self._trace,
        )

    def poll_and_act(self) -> Dict[str, Any]:
        return self._controller.poll_and_act()

    def status(self) -> Dict[str, Any]:
        return {
            **self._controller.status(),
            "runtime": "visual-interaction-runtime",
            "markIdentity": "structural+semantic-visual",
        }

    def grid_state(self) -> Dict[str, Any]:
        return self._grid.poll()

    def slider_state(self) -> Dict[str, Any]:
        return self._slider.poll()

    def slider_target_state(self) -> Dict[str, Any]:
        return self._slider_grounder.ground(self._slider.poll())

    def apply_grid_selection(self, indexes: Iterable[int], *, submit: bool = True) -> Dict[str, Any]:
        return self._grid_actions.apply(indexes, submit=submit)

    def apply_slider(self, target_fraction: float) -> Dict[str, Any]:
        return self._slider_actions.apply(target_fraction)
