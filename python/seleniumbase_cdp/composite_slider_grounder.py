from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict

from ddddocr_slider_provider import DdddOcrSliderProvider
from slider_target_grounder import SliderTargetGrounder


_RIGHT_END = re.compile(r"(?i)(right|to\s+the\s+end|until\s+the\s+end|end|finish|complete|rechts|bis\s+zum\s+ende|zum\s+ende|ende|fertig|abschlie)")
_LEFT_END = re.compile(r"(?i)(left|to\s+the\s+start|until\s+the\s+start|start|begin|links|bis\s+zum\s+anfang|zum\s+anfang|anfang|beginn)")


class CompositeSliderGrounder:
    """Ground sliders from explicit semantics first, then local puzzle matching."""

    _EXPLICIT_PRIMARY_SOURCES = {
        "instruction-percent",
        "instruction-value",
        "dom-target",
    }

    def __init__(self, seleniumbase_cdp: Any, *, profile_dir: str | Path | None = None) -> None:
        self._primary = SliderTargetGrounder(seleniumbase_cdp, profile_dir=profile_dir)
        self._ddddocr = DdddOcrSliderProvider(seleniumbase_cdp, profile_dir=profile_dir)

    def ground(self, state: Dict[str, Any]) -> Dict[str, Any]:
        instruction = str(state.get("instruction") or "")

        # A direct instruction to move a horizontal slider to an endpoint is
        # stronger evidence than pixel contrast on the rendered track. This
        # avoids the handle/track edge being mistaken for an intermediate goal.
        if str(state.get("orientation") or "horizontal") != "vertical":
            if _RIGHT_END.search(instruction):
                return {
                    "grounded": True,
                    "targetFraction": 0.985,
                    "confidence": 0.98,
                    "source": "instruction-end-right",
                    "markId": "S3",
                    "fallbackProvider": self._ddddocr.status(),
                }
            if _LEFT_END.search(instruction):
                return {
                    "grounded": True,
                    "targetFraction": 0.015,
                    "confidence": 0.98,
                    "source": "instruction-end-left",
                    "markId": "S3",
                    "fallbackProvider": self._ddddocr.status(),
                }

        primary = self._primary.ground(state)
        primary_source = str(primary.get("source") or "")

        # Explicit numeric/DOM targets are stronger than image matching and stay
        # deterministic for ordinary sliders.
        if bool(primary.get("grounded")) and primary_source in self._EXPLICIT_PRIMARY_SOURCES:
            return {**primary, "fallbackProvider": self._ddddocr.status()}

        # Puzzle-style sliders often expose no numeric/DOM target at all. When the
        # local matcher can identify a rendered piece/background pair, prefer that
        # result over weak visual-region or directional fallbacks.
        optional = self._ddddocr.ground(state)
        if optional:
            return {
                **optional,
                "primaryReason": str(primary.get("reason") or ""),
                "primarySource": primary_source,
            }

        if bool(primary.get("grounded")):
            return {**primary, "fallbackProvider": self._ddddocr.status()}

        return {**primary, "fallbackProvider": self._ddddocr.status()}

    def status(self) -> Dict[str, Any]:
        return {"ddddocr": self._ddddocr.status()}
