from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict


POLICY_FILENAME = ".ares-interaction-policy.json"

_DEFAULTS: Dict[str, Any] = {
    "watchdogIntervalMs": 800,
    "captureOnPageLoad": True,
    "captureOnNavigation": True,
    "captureOnGenerationChange": False,
    "captureOnIframe": True,
    "captureOnModal": True,
    "captureOnGrid": True,
    "captureOnSlider": True,
    "captureOnCanvas": True,
    "captureOnVerificationFailure": True,
    "maxSavedCaptures": 40,
}


class InteractionPolicy:
    """Small per-profile policy for ARES observation/capture behaviour."""

    def __init__(self, values: Dict[str, Any] | None = None) -> None:
        merged = dict(_DEFAULTS)
        if isinstance(values, dict):
            for key in _DEFAULTS:
                if key in values:
                    merged[key] = values[key]
        merged["watchdogIntervalMs"] = max(200, min(5000, int(merged["watchdogIntervalMs"])))
        merged["maxSavedCaptures"] = max(4, min(500, int(merged["maxSavedCaptures"])))
        for key in _DEFAULTS:
            if key.startswith("captureOn"):
                merged[key] = bool(merged[key])
        self._values = merged

    @classmethod
    def from_profile(cls, profile_dir: str | Path) -> "InteractionPolicy":
        path = Path(profile_dir).expanduser().resolve() / POLICY_FILENAME
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raw = {}
        except (OSError, json.JSONDecodeError):
            raw = {}
        return cls(raw if isinstance(raw, dict) else {})

    @property
    def watchdog_interval_seconds(self) -> float:
        return float(self._values["watchdogIntervalMs"]) / 1000.0

    @property
    def max_saved_captures(self) -> int:
        return int(self._values["maxSavedCaptures"])

    def capture_enabled(self, event: str) -> bool:
        mapping = {
            "page-load": "captureOnPageLoad",
            "navigation": "captureOnNavigation",
            "layout-generation-changed": "captureOnGenerationChange",
            "iframe-added": "captureOnIframe",
            "modal-opened": "captureOnModal",
            "grid-candidate": "captureOnGrid",
            "slider-candidate": "captureOnSlider",
            "canvas-candidate": "captureOnCanvas",
            "verification-failure": "captureOnVerificationFailure",
        }
        key = mapping.get(str(event or ""))
        return bool(key and self._values.get(key))

    def status(self) -> Dict[str, Any]:
        return {**self._values, "filename": POLICY_FILENAME}
