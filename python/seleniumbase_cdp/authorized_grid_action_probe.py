from __future__ import annotations

from authorized_grid_action_executor import AuthorizedGridActionExecutor


class FakeGridAdapter:
    def __init__(self) -> None:
        self._overrides = {"tiles": ".tile", "submit": ".submit"}
        self.calls = 0

    def poll(self):
        self.calls += 1
        return {
            "kind": "image-grid",
            "scope": "document",
            "tileCount": 9,
            "generation": 3 if self.calls == 1 else 4,
            "signature": "before" if self.calls == 1 else "after",
            "instruction": "select buses",
            "sources": [f"data:image/png;base64,{i}" for i in range(9)],
        }


class FakeSb:
    def __init__(self) -> None:
        self.script = ""

    def evaluate(self, script: str):
        self.script = script
        return {
            "status": "clicked",
            "clickedIndexes": [1, 4, 7],
            "submitted": True,
            "strategy": "dom",
        }


def main() -> int:
    sb = FakeSb()
    adapter = FakeGridAdapter()
    disabled = AuthorizedGridActionExecutor(sb, adapter, authorized=False)
    assert disabled.apply([1], expected_signature="before")["status"] == "disabled"

    adapter = FakeGridAdapter()
    executor = AuthorizedGridActionExecutor(sb, adapter, authorized=True)
    result = executor.apply([7, 1, 4, 4], expected_signature="before", expected_tile_count=9)
    assert result["status"] == "clicked"
    assert result["clickedIndexes"] == [1, 4, 7]
    assert result["submitted"] is True
    assert result["generationChanged"] is True
    assert "shadowRoot" in sb.script
    assert "contentDocument" in sb.script

    stale_adapter = FakeGridAdapter()
    stale = AuthorizedGridActionExecutor(sb, stale_adapter, authorized=True)
    result = stale.apply([1], expected_signature="wrong", expected_tile_count=9)
    assert result["status"] == "stale-grid"
    assert result["clickedIndexes"] == []

    print("Authorized SeleniumBase grid action probe passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
