from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, Iterable

from auto_interaction_controller import AutoInteractionController
from composite_slider_grounder import CompositeSliderGrounder
from consent_popup_handler import ConsentPopupHandler
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
        self._popup_handler = ConsentPopupHandler(self._sb)
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
        popup = self._popup_handler.dismiss_once()
        if popup.get("dismissed"):
            self._trace.append("popup-action", popup)
            return {"acted": True, "kind": "popup", "result": popup}

        checkout = self._popup_handler.advance_checkout_once()
        if checkout.get("advanced"):
            self._trace.append("checkout-action", checkout)
            return {"acted": True, "kind": "checkout", "result": checkout}

        grid_state = self._grid.poll()
        if grid_state.get("kind") == "image-grid":
            signature = str(grid_state.get("signature") or "")
            if signature and signature != self._last_grid_debug_signature:
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
                    if screenshot_result.get("kind") == "image-grid" and screenshot_result.get("reason") != "screenshot-grid-unavailable":
                        self._last_grid_debug_signature = signature
                    screenshot_result = self._finalize_interaction(screenshot_result)
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

        primary = self._finalize_interaction(self._controller.poll_and_act())
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

        tile_count = int(state.get("tileCount") or 0)
        marks = [
            mark for mark in state.get("marks") or []
            if isinstance(mark, dict) and mark.get("role") == "grid-tile"
        ]
        provided = self._screenshot_tiles.sources(screenshot_path, state)
        sources = list(provided.get("sources") or [])
        readable = int(provided.get("readable") or 0)
        crop_count = int(provided.get("cropCount") or 0)
        geometry_ready = tile_count > 0 and len(marks) == tile_count
        crops_ready = len(sources) == tile_count and readable == tile_count and crop_count == tile_count
        if not geometry_ready or not crops_ready:
            return {
                "acted": False,
                "kind": "image-grid",
                "reason": "screenshot-grid-unavailable",
                "state": state,
                "screenshot": provided,
                "invariants": {
                    "tileCount": tile_count,
                    "markCount": len(marks),
                    "cropCount": crop_count,
                    "readable": readable,
                    "geometryReady": geometry_ready,
                    "cropsReady": crops_ready,
                },
            }

        result = self._controller.act_grid_from_sources(state, sources, source="screenshot-crops")
        return {
            **result,
            "screenshot": provided,
            "invariants": {
                "tileCount": tile_count,
                "markCount": len(marks),
                "cropCount": crop_count,
                "readable": readable,
                "geometryReady": True,
                "cropsReady": True,
            },
        }

    def _finalize_interaction(self, result: Dict[str, Any]) -> Dict[str, Any]:
        kind = str(result.get("kind") or "")
        verified = bool(result.get("verified"))

        if kind == "image-grid" and not verified:
            attempt = int(result.get("attempt") or 0)
            max_attempts = int(result.get("maxAttempts") or 3)
            if result.get("reason") == "screenshot-grid-unavailable" or 0 < attempt < max_attempts:
                self._last_grid_debug_signature = ""
                self._trace.append(
                    "grid-retry-scheduled",
                    {
                        "attempt": attempt,
                        "nextAttempt": attempt + 1 if attempt else 1,
                        "maxAttempts": max_attempts,
                        "reason": result.get("reason"),
                    },
                )

        if verified and kind in {"image-grid", "slider"}:
            progress = self._advance_after_success()
            return {**result, "postSuccess": progress}
        return result

    def _advance_after_success(self) -> Dict[str, Any]:
        """Bounded post-success chain for confirm/continue/checkout progression."""
        deadline = time.monotonic() + 1.6
        dismissed = []
        while time.monotonic() < deadline:
            popup = self._popup_handler.dismiss_once()
            if popup.get("dismissed"):
                dismissed.append(popup)
                self._trace.append("post-success-popup", popup)
                time.sleep(0.08)
                continue

            progress = self._popup_handler.advance_progress_once()
            if progress.get("advanced"):
                payload = {
                    **progress,
                    "verifiedSource": "post-success-explicit-control",
                    "dismissedPopups": dismissed,
                }
                self._trace.append("post-success-progress", payload)
                return payload
            time.sleep(0.10)

        return {
            "advanced": False,
            "reason": "no-post-success-progress-control",
            "dismissedPopups": dismissed,
        }

    def status(self) -> Dict[str, Any]:
        return {
            **self._controller.status(),
            "runtime": "visual-interaction-runtime",
            "markIdentity": "structural+semantic-visual",
            "gridGeometry": "dynamic-2x2-through-8x8",
            "gridClickOrder": "nearest-neighbour",
            "gridCropInvariant": "one-mark-one-readable-crop",
            "gridTiming": {
                "clickDelaySeconds": self._policy.grid_click_delay_seconds,
                "submitDelaySeconds": self._policy.grid_submit_delay_seconds,
            },
            "popupAutoProgress": True,
            "checkoutAutoProgress": True,
            "postSuccessAutoProgress": True,
            "maxGridAttempts": 3,
            "freshScreenshotPerRetry": True,
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
