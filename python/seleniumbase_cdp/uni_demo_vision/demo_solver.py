from __future__ import annotations

import time
from dataclasses import asdict
from typing import Any, Dict, Iterable

from classifier import UniDemoVisionClassifier
from site_adapter import SiteSelectorOverride, UniversityDemoSiteAdapter


class UniDemoVisionRunner:
    """Run the university vision demo through a generic, configurable page adapter."""

    def __init__(
        self,
        seleniumbase_cdp: Any,
        classifier: UniDemoVisionClassifier,
        *,
        aliases: Dict[str, str] | None = None,
        threshold: float = 0.72,
        overrides: Iterable[SiteSelectorOverride] | None = None,
    ) -> None:
        self._classifier = classifier
        self._aliases = aliases or {}
        self._threshold = min(1.0, max(0.0, float(threshold)))
        self._adapter = UniversityDemoSiteAdapter(seleniumbase_cdp, overrides)
        self._last_generation = ""

    def poll_and_act(self) -> Dict[str, Any]:
        snapshot = self._adapter.snapshot()
        if not snapshot.get("matched"):
            return {"status": "not-matched"}

        generation = str(snapshot.get("generation") or "")
        if generation and generation == self._last_generation:
            return {"status": "unchanged", "generation": generation, "adapter": snapshot.get("adapter")}

        sources = [str(value) for value in snapshot.get("sources") or [] if str(value).strip()]
        target_raw = str(snapshot.get("target") or "").strip()
        if not sources or not target_raw:
            return {"status": "incomplete", "generation": generation, "adapter": snapshot.get("adapter")}

        target = self._classifier.normalize_target(target_raw, self._aliases)
        predictions = self._classifier.predict_sources(sources)
        selected = self._classifier.selected_indexes(predictions, target=target, threshold=self._threshold)
        acted = self._adapter.apply_selection(snapshot, selected)
        if acted:
            self._last_generation = generation
        return {
            "status": "selected" if acted else "selection-failed",
            "generation": generation,
            "adapter": snapshot.get("adapter"),
            "target": target,
            "selectedIndexes": selected,
            "predictions": [asdict(value) for value in predictions],
        }

    def run_until_complete(self, *, timeout: float = 20.0, poll_interval: float = 0.15) -> Dict[str, Any]:
        deadline = time.monotonic() + max(0.0, timeout)
        latest: Dict[str, Any] = {"status": "not-matched"}
        while time.monotonic() < deadline:
            latest = self.poll_and_act()
            if latest.get("status") == "not-matched":
                return latest
            snapshot = self._adapter.snapshot()
            state = self._adapter.completion_state(snapshot)
            if state == "complete":
                return {**latest, "status": "complete"}
            if state == "failed":
                return {**latest, "status": "failed"}
            time.sleep(max(0.03, poll_interval))
        return {**latest, "status": "timeout"}
