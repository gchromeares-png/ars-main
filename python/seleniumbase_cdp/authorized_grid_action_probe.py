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
        return {"status": "clicked", "clickedIndexes": [1, 4, 7], "submitted": True, "strategy": "dom"}


def main() -> int:
    sb = FakeSb()
    result = AuthorizedGridActionExecutor(sb, FakeGridAdapter()).apply([7, 1, 4, 4], expected_signature="before")
    assert result["status"] == "clicked"
    assert result["clickedIndexes"] == [1, 4, 7]
    assert result["generationChanged"] is True
    assert "shadowRoot" in sb.script and "contentDocument" in sb.script

    stale = AuthorizedGridActionExecutor(sb, FakeGridAdapter()).apply([1], expected_signature="wrong")
    assert stale["status"] == "stale-grid"
    assert stale["clickedIndexes"] == []

    print("SeleniumBase grid action probe passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
