from __future__ import annotations

import json
import time
from dataclasses import asdict
from typing import Any, Dict, List

from classifier import UniDemoVisionClassifier


class UniDemoVisionRunner:
    """Solve only explicitly cooperative ARES university demo grids.

    A page opts in by rendering a container with data-ares-demo-challenge.
    Tiles are marked with data-ares-demo-tile and contain an img element.
    The target class is supplied by data-ares-demo-target. This contract keeps
    the demo path separate from real CAPTCHA provider markup.
    """

    def __init__(
        self,
        seleniumbase_cdp: Any,
        classifier: UniDemoVisionClassifier,
        *,
        aliases: Dict[str, str] | None = None,
        threshold: float = 0.72,
    ) -> None:
        self._sb = seleniumbase_cdp
        self._classifier = classifier
        self._aliases = aliases or {}
        self._threshold = min(1.0, max(0.0, float(threshold)))
        self._last_generation = ""

    def poll_and_act(self) -> Dict[str, Any]:
        snapshot = self._snapshot()
        if not snapshot.get("optedIn"):
            return {"status": "not-demo"}

        generation = str(snapshot.get("generation") or "")
        if generation and generation == self._last_generation:
            return {"status": "unchanged", "generation": generation}

        sources = [str(value) for value in snapshot.get("sources") or [] if str(value).strip()]
        target_raw = str(snapshot.get("target") or "").strip()
        if not sources or not target_raw:
            return {"status": "incomplete", "generation": generation}

        target = self._classifier.normalize_target(target_raw, self._aliases)
        predictions = self._classifier.predict_sources(sources)
        selected = self._classifier.selected_indexes(
            predictions,
            target=target,
            threshold=self._threshold,
        )
        self._apply_selection(selected)
        self._last_generation = generation
        return {
            "status": "selected",
            "generation": generation,
            "target": target,
            "selectedIndexes": selected,
            "predictions": [asdict(value) for value in predictions],
        }

    def run_until_complete(self, *, timeout: float = 20.0, poll_interval: float = 0.15) -> Dict[str, Any]:
        deadline = time.monotonic() + max(0.0, timeout)
        latest: Dict[str, Any] = {"status": "not-demo"}
        while time.monotonic() < deadline:
            latest = self.poll_and_act()
            if latest.get("status") == "not-demo":
                return latest
            state = self._completion_state()
            if state == "complete":
                return {**latest, "status": "complete"}
            if state == "failed":
                return {**latest, "status": "failed"}
            time.sleep(max(0.03, poll_interval))
        return {**latest, "status": "timeout"}

    def _snapshot(self) -> Dict[str, Any]:
        script = r"""
        (() => {
          const root = document.querySelector('[data-ares-demo-challenge]');
          if (!root) return { optedIn: false };
          const tiles = [...root.querySelectorAll('[data-ares-demo-tile]')];
          return {
            optedIn: true,
            target: root.getAttribute('data-ares-demo-target') || '',
            generation: root.getAttribute('data-ares-demo-generation') ||
                        tiles.map((tile) => {
                          const img = tile.querySelector('img');
                          return img ? (img.currentSrc || img.src || '') : '';
                        }).join('|'),
            sources: tiles.map((tile) => {
              const img = tile.querySelector('img');
              return img ? (img.currentSrc || img.src || '') : '';
            })
          };
        })()
        """
        value = self._sb.evaluate(script)
        return dict(value) if isinstance(value, dict) else {"optedIn": False}

    def _apply_selection(self, indexes: List[int]) -> None:
        encoded = json.dumps([int(index) for index in indexes])
        script = f"""
        (() => {{
          const indexes = {encoded};
          const root = document.querySelector('[data-ares-demo-challenge]');
          if (!root) return false;
          const tiles = [...root.querySelectorAll('[data-ares-demo-tile]')];
          indexes.forEach((index) => {{
            const tile = tiles[index];
            if (tile && tile.getAttribute('aria-pressed') !== 'true') tile.click();
          }});
          const submit = root.querySelector('[data-ares-demo-submit]');
          if (submit) submit.click();
          return true;
        }})()
        """
        self._sb.evaluate(script)

    def _completion_state(self) -> str:
        script = r"""
        (() => {
          const root = document.querySelector('[data-ares-demo-challenge]');
          if (!root) return 'missing';
          if (root.getAttribute('data-ares-demo-complete') === 'true') return 'complete';
          if (root.getAttribute('data-ares-demo-failed') === 'true') return 'failed';
          return 'pending';
        })()
        """
        return str(self._sb.evaluate(script) or "pending")
