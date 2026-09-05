from __future__ import annotations

from typing import Any, Dict, List

from site_grid_adapter import GridSiteAdapter


class FakeElement:
    def __init__(self, *, attrs: Dict[str, str] | None = None, images: List["FakeElement"] | None = None, width: int = 100, height: int = 100) -> None:
        self.attrs = attrs or {}
        self.images = images or []
        self.width = width
        self.height = height

    def query_selector_all(self, selector: str) -> List["FakeElement"]:
        return self.images if selector == "img" else []

    def get_attribute(self, name: str) -> str | None:
        return self.attrs.get(name)

    def get_position(self) -> Dict[str, int]:
        return {"x": 0, "y": 0, "width": self.width, "height": self.height}


class FakeCdp:
    def __init__(self) -> None:
        self.mode = "document"
        sources = [f"https://fixture.local/{index}.png" for index in range(9)]
        self.document_payload: Dict[str, Any] = {
            "kind": "image-grid",
            "scope": "document/shadow",
            "score": 92,
            "rows": 3,
            "columns": 3,
            "tileCount": 9,
            "instruction": "Select the matching objects",
            "sources": sources,
            "submitText": "Verify",
            "rawMarks": [self._raw_tile(index, source) for index, source in enumerate(sources)],
            "viewport": {"width": 1280, "height": 720, "scrollX": 0, "scrollY": 0, "devicePixelRatio": 1},
            "override": False,
        }

    @staticmethod
    def _raw_tile(index: int, source: str) -> Dict[str, Any]:
        return {
            "role": "grid-tile",
            "index": index,
            "visualBounds": {"x": index * 12, "y": 4, "width": 10, "height": 10},
            "confidence": 0.9,
            "structuralKey": f"grid-tile|slot:{index}",
            "semanticSignature": f"grid-tile|{source}",
            "source": source,
            "label": f"tile {index}",
        }

    def evaluate(self, _script: str) -> Dict[str, Any]:
        if self.mode == "document":
            return dict(self.document_payload)
        return {"kind": "none"}

    def find_elements(self, selector: str) -> List[FakeElement]:
        if selector != "iframe" or self.mode != "iframe":
            return []
        images = [FakeElement(attrs={"src": f"https://frame.local/{index}.jpg"}) for index in range(16)]
        return [FakeElement(attrs={"title": "authorized test grid"}, images=images)]


def main() -> int:
    cdp = FakeCdp()
    adapter = GridSiteAdapter(cdp)

    first = adapter.poll()
    assert first["kind"] == "image-grid"
    assert first["rows"] == 3 and first["columns"] == 3
    assert first["tileCount"] == 9
    assert first["generation"] == 1
    assert len(first["marks"]) == 9
    assert first["marks"][0]["visualBounds"]
    assert first["marks"][0]["frame"] == "document/shadow"
    assert first["marks"][0]["semanticVisualSignature"]

    unchanged = adapter.poll()
    assert unchanged["generation"] == 1

    new_source = "https://fixture.local/4-v2.png"
    cdp.document_payload["sources"][4] = new_source
    cdp.document_payload["rawMarks"][4] = cdp._raw_tile(4, new_source)
    changed = adapter.poll()
    assert changed["generation"] == 2

    cdp.mode = "iframe"
    framed = adapter.poll()
    assert framed["kind"] == "image-grid"
    assert framed["scope"] == "iframe:0"
    assert framed["rows"] == 4 and framed["columns"] == 4
    assert framed["tileCount"] == 16
    assert framed["generation"] == 3
    assert len(framed["marks"]) == 16

    overridden = GridSiteAdapter(cdp, overrides={
        "root": ".board",
        "tiles": ".tile",
        "instruction": ".task",
        "submit": ".submit",
        "unknown": ".ignored",
    })
    assert overridden._overrides == {
        "root": ".board",
        "tiles": ".tile",
        "instruction": ".task",
        "submit": ".submit",
    }

    print("SeleniumBase structural site adapter probe passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
