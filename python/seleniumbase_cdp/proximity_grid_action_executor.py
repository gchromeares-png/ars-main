from __future__ import annotations

from typing import Any, Dict, Iterable, List, Tuple

from authorized_grid_action_executor import AuthorizedGridActionExecutor


class ProximityGridActionExecutor(AuthorizedGridActionExecutor):
    """Click selected grid tiles in a deterministic nearest-neighbour order."""

    def apply(self, indexes: Iterable[int], *, submit: bool = True) -> Dict[str, Any]:
        state = self._site_adapter.poll()
        selected = self._ordered_indexes(
            state,
            self._clean_indexes(indexes, int(state.get("tileCount") or 0)),
        )
        return self._apply_state(state, selected, submit=submit)

    def apply_marks(self, mark_ids: Iterable[str], *, submit: bool = True) -> Dict[str, Any]:
        state = self._site_adapter.poll()
        requested = {str(value) for value in mark_ids if str(value)}
        marks = [
            mark
            for mark in state.get("marks") or []
            if isinstance(mark, dict) and mark.get("role") == "grid-tile"
        ]
        selected = [
            index
            for index, mark in enumerate(marks)
            if str(mark.get("markId") or "") in requested
        ]
        selected = self._ordered_indexes(state, selected)
        result = self._apply_state(state, selected, submit=submit)

        clicked_order = [int(value) for value in result.get("clickedIndexes") or []]
        result["requestedMarkIds"] = sorted(requested)
        result["clickedMarkIds"] = [
            str(marks[index].get("markId") or "")
            for index in clicked_order
            if 0 <= index < len(marks) and marks[index].get("markId")
        ]
        result["clickOrder"] = clicked_order
        return result

    @staticmethod
    def _indexes(values: Iterable[int], count: int) -> List[int]:
        # Parent _apply_state calls this again. Preserve the proximity order
        # already computed by this subclass instead of sorting it away.
        result: List[int] = []
        seen = set()
        for value in values:
            try:
                index = int(value)
            except (TypeError, ValueError):
                continue
            if 0 <= index < count and index not in seen:
                seen.add(index)
                result.append(index)
        return result

    @staticmethod
    def _clean_indexes(values: Iterable[int], count: int) -> List[int]:
        clean = set()
        for value in values:
            try:
                index = int(value)
            except (TypeError, ValueError):
                continue
            if 0 <= index < count:
                clean.add(index)
        return sorted(clean)

    @classmethod
    def _ordered_indexes(cls, state: Dict[str, Any], selected: List[int]) -> List[int]:
        if len(selected) <= 1:
            return list(selected)

        marks = [
            mark
            for mark in state.get("marks") or []
            if isinstance(mark, dict) and mark.get("role") == "grid-tile"
        ]
        centers: Dict[int, Tuple[float, float]] = {}
        for index in selected:
            if not (0 <= index < len(marks)):
                continue
            bounds = marks[index].get("visualBounds")
            if not isinstance(bounds, dict):
                continue
            try:
                x = float(bounds.get("x") or 0.0)
                y = float(bounds.get("y") or 0.0)
                width = float(bounds.get("width") or 0.0)
                height = float(bounds.get("height") or 0.0)
            except (TypeError, ValueError):
                continue
            if width <= 0 or height <= 0:
                continue
            centers[index] = (x + width / 2.0, y + height / 2.0)

        if len(centers) != len(selected):
            return list(selected)

        remaining = set(selected)
        # Stable deterministic anchor: top-most, then left-most selected tile.
        current = min(
            remaining,
            key=lambda index: (
                centers[index][1],
                centers[index][0],
                index,
            ),
        )
        order = [current]
        remaining.remove(current)

        while remaining:
            cx, cy = centers[current]
            current = min(
                remaining,
                key=lambda index: (
                    (centers[index][0] - cx) ** 2 + (centers[index][1] - cy) ** 2,
                    centers[index][1],
                    centers[index][0],
                    index,
                ),
            )
            order.append(current)
            remaining.remove(current)

        return order
