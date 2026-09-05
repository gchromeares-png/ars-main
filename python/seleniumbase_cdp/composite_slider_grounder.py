from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from ddddocr_slider_provider import DdddOcrSliderProvider
from slider_target_grounder import SliderTargetGrounder


class CompositeSliderGrounder:
    """Use the existing grounder first, then optional ddddocr image matching."""

    def __init__(self, seleniumbase_cdp: Any, *, profile_dir: str | Path | None = None) -> None:
        self._primary = SliderTargetGrounder(seleniumbase_cdp, profile_dir=profile_dir)
        self._ddddocr = DdddOcrSliderProvider(seleniumbase_cdp, profile_dir=profile_dir)

    def ground(self, state: Dict[str, Any]) -> Dict[str, Any]:
        primary = self._primary.ground(state)
        if bool(primary.get("grounded")):
            return {**primary, "fallbackProvider": self._ddddocr.status()}

        optional = self._ddddocr.ground(state)
        if optional:
            return {**optional, "primaryReason": str(primary.get("reason") or "")}

        return {**primary, "fallbackProvider": self._ddddocr.status()}

    def status(self) -> Dict[str, Any]:
        return {"ddddocr": self._ddddocr.status()}
