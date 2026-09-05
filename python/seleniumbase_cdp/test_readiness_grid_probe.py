from interaction_policy import InteractionPolicy
from extended_grid_site_adapter import ExtendedGridSiteAdapter
from proximity_grid_action_executor import ProximityGridActionExecutor
from robust_vision_grid_classifier import RobustVisionGridClassifier


def _rects(rows: int, columns: int, *, size: float = 40.0, gap: float = 8.0):
    return [
        {
            "x": column * (size + gap),
            "y": row * (size + gap),
            "width": size,
            "height": size,
        }
        for row in range(rows)
        for column in range(columns)
    ]


def _marks(rows: int, columns: int):
    return [
        {
            "role": "grid-tile",
            "visualBounds": rect,
            "markId": f"tile-{index}",
        }
        for index, rect in enumerate(_rects(rows, columns))
    ]


class FakeAdapter:
    def __init__(self) -> None:
        self._overrides = {"tiles": ".tile", "submit": ".submit"}
        self.calls = 0

    def poll(self):
        self.calls += 1
        return {
            "kind": "image-grid",
            "scope": "document",
            "rows": 8,
            "columns": 8,
            "tileCount": 64,
            "generation": self.calls,
            "signature": f"g-{self.calls}",
            "marks": _marks(8, 8),
        }


class FakeCdp:
    def __init__(self) -> None:
        self.scripts = []

    def evaluate(self, script):
        self.scripts.append(script)
        return True


def main() -> int:
    assert ExtendedGridSiteAdapter._infer_shape(_rects(4, 4)) == (4, 4)
    assert ExtendedGridSiteAdapter._infer_shape(_rects(8, 8)) == (8, 8)
    assert ExtendedGridSiteAdapter._infer_shape(_rects(2, 3)) == (2, 3)

    state = {"marks": _marks(4, 4)}
    order = ProximityGridActionExecutor._ordered_indexes(state, [15, 7, 3, 0])
    assert order == [0, 3, 7, 15], order

    policy = InteractionPolicy({
        "gridClickDelayMinMs": 0,
        "gridClickDelayMaxMs": 0,
        "gridSubmitDelayMs": 0,
    })
    cdp = FakeCdp()
    executor = ProximityGridActionExecutor(cdp, FakeAdapter(), policy)
    execution = executor.apply([9, 8, 1, 0], submit=True)
    assert execution["clickedIndexes"] == [0, 1, 9, 8], execution
    assert execution["clickOrder"] == [0, 1, 9, 8], execution
    assert execution["submitted"] is True, execution
    assert len(cdp.scripts) == 5, len(cdp.scripts)
    assert all("count >= 4 && count <= 64" in script for script in cdp.scripts), cdp.scripts[0]

    classifier = RobustVisionGridClassifier()
    assert classifier._target_text("Klicke auf Ampeln") == "Ampeln"
    assert classifier._target_text("Click all traffic lights") == "traffic lights"
    assert classifier._target_text("Wähle alle Bilder mit Fahrrädern") == "Fahrrädern"

    print("Test-readiness grid geometry, 8x8 proximity execution, and prompt extraction passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
