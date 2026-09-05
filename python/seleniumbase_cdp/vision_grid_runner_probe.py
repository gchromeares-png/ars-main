from __future__ import annotations

from dataclasses import dataclass

from vision_grid_runner import VisionGridRunner


@dataclass
class Prediction:
    label: str
    confidence: float


class FakeClassifier:
    def target_from_instruction(self, instruction, aliases):
        return "bus" if "bus" in instruction.lower() else ""

    def predict_sources(self, sources):
        return [Prediction("bus", 0.9) if index in {1, 4} else Prediction("car", 0.95) for index, _ in enumerate(sources)]

    def selected_indexes(self, predictions, target, threshold):
        return [index for index, prediction in enumerate(predictions) if prediction.label == target and prediction.confidence >= threshold]


class FakeAdapter:
    def __init__(self):
        self.signature = "grid-a"
        self.actions = []

    def site_grid_state(self):
        return {"kind": "image-grid", "signature": self.signature, "tileCount": 9, "instruction": "Select bus", "sources": [f"data:image/png;base64,{i}" for i in range(9)]}

    def execute_async_script(self, _script):
        return self.site_grid_state()["sources"]

    def apply_grid_selection(self, indexes, submit=True, expected_signature=""):
        assert expected_signature == self.signature
        self.actions.append(list(indexes))
        before = self.signature
        self.signature = "grid-b"
        return {"clickedIndexes": list(indexes), "submitted": submit, "state": self.site_grid_state(), "before": before}


def main() -> int:
    adapter = FakeAdapter()
    runner = VisionGridRunner(adapter, FakeClassifier())
    first = runner.tick()
    assert first["status"] == "clicked" and first["indexes"] == [1, 4]
    second = runner.tick()
    assert second["status"] == "clicked"
    third = runner.tick()
    assert third["status"] == "idle"
    assert adapter.actions == [[1, 4], [1, 4]]
    print("Vision grid runner probe passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
