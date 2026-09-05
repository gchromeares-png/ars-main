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


def main() -> int:
    assert ExtendedGridSiteAdapter._infer_shape(_rects(4, 4)) == (4, 4)
    assert ExtendedGridSiteAdapter._infer_shape(_rects(8, 8)) == (8, 8)
    assert ExtendedGridSiteAdapter._infer_shape(_rects(2, 3)) == (2, 3)

    state = {"marks": _marks(4, 4)}
    order = ProximityGridActionExecutor._ordered_indexes(state, [15, 7, 3, 0])
    assert order == [0, 3, 7, 15], order

    classifier = RobustVisionGridClassifier()
    assert classifier._target_text("Klicke auf Ampeln") == "Ampeln"
    assert classifier._target_text("Click all traffic lights") == "traffic lights"
    assert classifier._target_text("Wähle alle Bilder mit Fahrrädern") == "Fahrrädern"

    print("Test-readiness grid geometry, nearest-tile ordering, and prompt extraction passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
