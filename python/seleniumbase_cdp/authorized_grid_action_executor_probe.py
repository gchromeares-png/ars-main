from __future__ import annotations

from authorized_grid_action_executor import AuthorizedGridActionExecutor
from interaction_policy import InteractionPolicy


class FakeAdapter:
    def __init__(self) -> None:
        self._overrides = {"tiles": ".tile", "submit": ".submit"}
        self.calls = 0

    def poll(self):
        self.calls += 1
        marks = []
        for index in range(9):
            row, column = divmod(index, 3)
            marks.append({
                "role": "grid-tile",
                "markId": f"M{index}",
                "visualBounds": {"x": column * 100, "y": row * 100, "width": 80, "height": 80},
            })
        return {
            "kind": "image-grid",
            "scope": "document",
            "tileCount": 9,
            "generation": self.calls,
            "signature": f"sig-{self.calls}",
            "marks": marks,
        }


class FakeCdp:
    def __init__(self) -> None:
        self.scripts = []

    def evaluate(self, script):
        self.scripts.append(script)
        return True


def main() -> int:
    cdp = FakeCdp()
    adapter = FakeAdapter()
    policy = InteractionPolicy({
        "gridClickDelayMinMs": 0,
        "gridClickDelayMaxMs": 0,
        "gridSubmitDelayMs": 0,
    })
    executor = AuthorizedGridActionExecutor(cdp, adapter, policy)

    result = executor.apply([8, 3, 1, 3, -1, 99], submit=True)
    assert result["clickedIndexes"] == [1, 3, 8], result
    assert result["clickOrder"] == [1, 3, 8], result
    assert result["submitted"] is True
    assert result["state"]["generation"] == 2
    assert len(cdp.scripts) == 4, len(cdp.scripts)
    assert all('"tiles": ".tile"' in script for script in cdp.scripts)
    assert adapter.calls == 2

    empty = AuthorizedGridActionExecutor(cdp, adapter, policy)._indexes([], 9)
    assert empty == []
    print("Authorized grid action executor probe passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
