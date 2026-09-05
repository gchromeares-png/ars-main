from __future__ import annotations

from auto_interaction_controller import AutoInteractionController
from site_slider_adapter import SliderSiteAdapter
from slider_action_executor import SliderActionExecutor


class FakeSb:
    def __init__(self) -> None:
        self.mode = "slider"
        self.fraction = 0.15

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
                "override": False,
            }
        return {"kind": "none", "scope": "document", "score": 0}


class FakeGridAdapter:
    def __init__(self) -> None:
        self.signature = "grid-a"

    def poll(self):
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
    def __init__(self) -> None:
        self.calls = []

    def apply(self, indexes, *, submit=True):
        self.calls.append((list(indexes), submit))
        return {"clickedIndexes": list(indexes), "submitted": submit}


class FakeSliderActions:
    def apply(self, target_fraction=0.96):
        return {"moved": True, "targetFraction": target_fraction}


def main() -> int:
    sb = FakeSb()
    slider = SliderSiteAdapter(sb)
    first = slider.poll()
    assert first["kind"] == "slider" and first["orientation"] == "horizontal"
    moved = SliderActionExecutor(sb, slider).apply(0.96)
    assert moved["moved"] is True and moved["state"]["fraction"] == 0.96

    grid = FakeGridAdapter()
    grid_actions = FakeGridActions()
    controller = AutoInteractionController(
        grid,
        FakeSliderNone(),
        grid_actions,
        FakeSliderActions(),
        FakeVision(),
    )
    result = controller.poll_and_act()
    assert result["acted"] is True
    assert grid_actions.calls == [([1, 4, 7], True)]
    duplicate = controller.poll_and_act()
    assert duplicate["acted"] is False

    grid.signature = "grid-b"
    changed = controller.poll_and_act()
    assert changed["acted"] is True
    assert len(grid_actions.calls) == 2

    print("Automatic SeleniumBase interaction probe passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
