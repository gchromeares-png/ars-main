from __future__ import annotations

from auto_interaction_controller import AutoInteractionController
from site_slider_adapter import SliderSiteAdapter
from slider_action_executor import SliderActionExecutor


class FakeSb:
    def __init__(self) -> None:
        self.mode = "slider"
        self.fraction = 0.15
        self.drags = []

    def evaluate(self, script: str):
        if "PointerEvent" in script:
            self.fraction = 0.96
            return True
        if self.mode == "slider":
            return {
                "kind": "slider",
                "scope": "document",
                "score": 85,
                "orientation": "horizontal",
                "fraction": self.fraction,
                "min": 0,
                "max": 100,
                "value": self.fraction * 100,
                "instruction": "Ziehe den Regler nach rechts zum Bestätigen",
                "handleRect": {"x": 20, "y": 20, "width": 24, "height": 24},
                "trackRect": {"x": 20, "y": 20, "width": 300, "height": 24},
                "handleSelector": "input[type=\"range\"]",
                "trackSelector": "input[type=\"range\"]",
                "nativeRange": True,
                "targetCandidates": [],
                "marks": [],
                "complete": False,
                "failed": False,
                "override": False,
            }
        return {"kind": "none", "scope": "document", "score": 0}

    def get_gui_element_center(self, _selector: str):
        return 170, 32

    def gui_drag_drop_points(self, x1, y1, x2, y2, timeframe=0.55):
        self.drags.append((x1, y1, x2, y2, timeframe))
        self.fraction = 0.96


class FakePaths:
    def play_drag(self, sb, start, end, *, preferred="ghost-cursor"):
        assert preferred == "ghost-cursor"
        sb.gui_drag_drop_points(start[0], start[1], end[0], end[1], timeframe=0.55)
        return {"moved": True, "provider": "ghost-cursor", "pointCount": 33}


class FakeGridAdapter:
    def __init__(self) -> None:
        self.signature = "grid-a"
        self.active = True

    def poll(self):
        if not self.active:
            return {"kind": "none", "score": 0, "signature": "none"}
        return {
            "kind": "image-grid",
            "score": 95,
            "tileCount": 9,
            "instruction": "Select all images with bicycles",
            "sources": [f"data:image/png;base64,{index}" for index in range(9)],
            "signature": self.signature,
            "override": False,
        }


class FakeSliderNone:
    def poll(self):
        return {"kind": "none", "score": 0, "signature": "none"}


class FakeVision:
    def status(self):
        return {"ready": True, "model": "fake"}

    def classify(self, instruction, sources):
        assert "bicycles" in instruction
        assert len(list(sources)) == 9
        return {"selectedIndexes": [1, 4, 7], "scores": [0.1, 0.9]}


class FakeGridActions:
    def __init__(self, adapter) -> None:
        self.adapter = adapter
        self.calls = []

    def apply(self, indexes, *, submit=True):
        self.calls.append((list(indexes), submit))
        self.adapter.active = False
        return {"clickedIndexes": list(indexes), "submitted": submit, "state": self.adapter.poll()}


class FakeSliderActions:
    def apply(self, target_fraction=0.96, *, state=None, force_fallback=False):
        return {"moved": True, "targetFraction": target_fraction, "mode": "fake", "state": state or {}}


def main() -> int:
    sb = FakeSb()
    slider = SliderSiteAdapter(sb)
    first = slider.poll()
    assert first["kind"] == "slider" and first["orientation"] == "horizontal"
    moved = SliderActionExecutor(sb, slider, FakePaths()).apply(0.96)
    assert moved["moved"] is True and moved["mode"] == "path:ghost-cursor"
    assert moved["state"]["fraction"] == 0.96 and len(sb.drags) == 1

    grid = FakeGridAdapter()
    grid_actions = FakeGridActions(grid)
    controller = AutoInteractionController(
        grid,
        FakeSliderNone(),
        grid_actions,
        FakeSliderActions(),
        FakeVision(),
    )
    result = controller.poll_and_act()
    assert result["acted"] is True and result["verified"] is True
    assert grid_actions.calls == [([1, 4, 7], True)]
    duplicate = controller.poll_and_act()
    assert duplicate["acted"] is False

    grid.active = True
    grid.signature = "grid-b"
    changed = controller.poll_and_act()
    assert changed["acted"] is True
    assert len(grid_actions.calls) == 2

    print("Automatic SeleniumBase interaction probe passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
