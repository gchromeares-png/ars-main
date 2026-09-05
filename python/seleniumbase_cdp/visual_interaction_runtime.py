from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterable

from auto_interaction_controller import AutoInteractionController
from composite_slider_grounder import CompositeSliderGrounder
from cursor_path_provider import CursorPathProvider
from extended_grid_site_adapter import ExtendedGridSiteAdapter
from interaction_policy import InteractionPolicy
from interaction_trace import InteractionTrace
from proximity_grid_action_executor import ProximityGridActionExecutor
from robust_vision_grid_classifier import RobustVisionGridClassifier
from screenshot_grid_tile_provider import ScreenshotGridTileProvider
from site_slider_adapter import SliderSiteAdapter
from slider_action_executor import SliderActionExecutor


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
        self._policy = InteractionPolicy.from_profile(self._profile_dir)
        self._grid = ExtendedGridSiteAdapter(self._sb, overrides=overrides or {})
        self._slider = SliderSiteAdapter(self._sb, overrides=overrides or {})
        self._paths = CursorPathProvider()
        self._grid_actions = ProximityGridActionExecutor(self._sb, self._grid, self._policy)
        self._slider_actions = SliderActionExecutor(self._sb, self._slider, self._paths)
        self._vision = RobustVisionGridClassifier()
        self._screenshot_tiles = ScreenshotGridTileProvider()
        self._slider_grounder = CompositeSliderGrounder(self._sb, profile_dir=self._profile_dir)
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

    def poll_and_act_from_screenshot(self, screenshot_path: str | Path) -> Dict[str, Any]:
        state = self._grid.poll()
        if state.get("kind") != "image-grid":
            return {"acted": False, "kind": "none", "reason": "no-image-grid", "state": state}

        provided = self._screenshot_tiles.sources(screenshot_path, state)
        sources = list(provided.get("sources") or [])
        if not sources or not any(sources):
            return {
                "acted": False,
                "kind": "image-grid",
                "reason": "screenshot-grid-unavailable",
                "state": state,
                "screenshot": provided,
            }

        result = self._controller.act_grid_from_sources(state, sources, source="screenshot-crops")
        return {**result, "screenshot": provided}

    def status(self) -> Dict[str, Any]:
        return {
            **self._controller.status(),
            "runtime": "visual-interaction-runtime",
            "markIdentity": "structural+semantic-visual",
            "gridGeometry": "dynamic-2x2-through-8x8",
            "gridClickOrder": "nearest-neighbour",
            "gridTiming": {
                "clickDelaySeconds": self._policy.grid_click_delay_seconds,
                "submitDelaySeconds": self._policy.grid_submit_delay_seconds,
            },
            "screenshotGridFallback": True,
            "sliderProviders": self._slider_grounder.status(),
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
