from __future__ import annotations

import time
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
        self._debug_root = self._profile_dir / ".ares-observations"
        self._last_grid_debug_signature = ""

    def poll_and_act(self) -> Dict[str, Any]:
        # Image grids need pixels before vision can make a meaningful decision.
        # Capture first, then crop/classify/click. Structural sources remain a
        # fallback only when screenshot capture/cropping is unavailable.
        grid_state = self._grid.poll()
        if grid_state.get("kind") == "image-grid":
            signature = str(grid_state.get("signature") or "")
            if signature and signature != self._last_grid_debug_signature:
                self._last_grid_debug_signature = signature
                captured = self._capture_grid_debug_screenshot(signature)
                self._trace.append(
                    "grid-screenshot-captured",
                    {
                        "kind": "image-grid",
                        "state": grid_state,
                        "capture": captured,
                    },
                )
                if bool(captured.get("captured")):
                    screenshot_result = self.poll_and_act_from_screenshot(str(captured.get("path") or ""))
                    self._trace.append(
                        "grid-screenshot-result",
                        {
                            "kind": "image-grid",
                            "capture": captured,
                            "result": screenshot_result,
                        },
                    )
                    return {
                        **screenshot_result,
                        "debugScreenshot": captured,
                        "screenshotFirst": True,
                    }

                self._trace.append(
                    "grid-screenshot-unavailable",
                    {
                        "kind": "image-grid",
                        "state": grid_state,
                        "capture": captured,
                    },
                )

        primary = self._controller.poll_and_act()
        if primary.get("kind") != "image-grid" or bool(primary.get("acted")):
            return primary

        state = primary.get("state") if isinstance(primary.get("state"), dict) else grid_state
        signature = str(state.get("signature") or "")
        return {
            **primary,
            "screenshotFirst": bool(signature and signature == self._last_grid_debug_signature),
            "screenshotFallback": {
                "attempted": bool(signature),
                "reason": "capture-or-crop-unavailable" if signature else "missing-grid-signature",
            },
        }

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
            "screenshotFirstForGrid": True,
            "debugScreenshotRoot": str(self._debug_root),
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

    def _capture_grid_debug_screenshot(self, signature: str) -> Dict[str, Any]:
        self._debug_root.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        unique = time.time_ns() % 1_000_000_000
        short_signature = signature[:12] if signature else "unknown"
        filename = f"{stamp}-{unique:09d}-grid-{short_signature}.png"
        path = self._debug_root / filename
        try:
            self._sb.save_screenshot(filename, folder=str(self._debug_root))
            captured = path.exists() and path.stat().st_size > 0
        except Exception as exc:
            return {
                "captured": False,
                "reason": "capture-error",
                "error": str(exc),
                "path": str(path),
            }

        if captured:
            self._rotate_debug_screenshots()
        return {
            "captured": captured,
            "reason": "captured" if captured else "missing-output",
            "path": str(path),
        }

    def _rotate_debug_screenshots(self) -> None:
        try:
            files = sorted(
                (path for path in self._debug_root.glob("*.png") if path.is_file()),
                key=lambda path: path.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            return
        for path in files[self._policy.max_saved_captures :]:
            try:
                path.unlink()
            except OSError:
                pass
