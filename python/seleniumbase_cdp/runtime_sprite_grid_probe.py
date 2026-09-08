from __future__ import annotations

import json
from urllib.parse import quote

from seleniumbase import SB

from authorized_grid_action_executor import AuthorizedGridActionExecutor
from extended_grid_site_adapter import _OOPIF_GRID_SCRIPT
from runtime_oopif_grid_site_adapter import ScopeLockedGridSiteAdapter


HTML = """
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 20px; font-family: sans-serif; }
  table { border-collapse: collapse; }
  td.grid-tile { width: 95px; height: 95px; padding: 0; }
  .wrapper { position: relative; width: 95px; height: 95px; overflow: hidden; }
  .sprite-image-tile-44 {
    position: absolute;
    width: 380px;
    height: 380px;
    max-width: none;
  }
</style>
</head>
<body>
  <p>Wähle alle passenden Felder aus</p>
  <table id="grid"><tbody>
    <tr>
      <td role="button" tabindex="0" id="0" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:0;left:0" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="1" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:0;left:-95px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="2" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:0;left:-190px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="3" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:0;left:-285px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
    </tr>
    <tr>
      <td role="button" tabindex="0" id="4" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-95px;left:0" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="5" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-95px;left:-95px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="6" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-95px;left:-190px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="7" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-95px;left:-285px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
    </tr>
    <tr>
      <td role="button" tabindex="0" id="8" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-190px;left:0" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="9" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-190px;left:-95px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="10" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-190px;left:-190px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="11" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-190px;left:-285px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
    </tr>
    <tr>
      <td role="button" tabindex="0" id="12" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-285px;left:0" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="13" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-285px;left:-95px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="14" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-285px;left:-190px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
      <td role="button" tabindex="0" id="15" class="grid-tile"><div class="wrapper"><img class="sprite-image-tile-44" style="top:-285px;left:-285px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='380' height='380'%3E%3Crect width='380' height='380' fill='gray'/%3E%3C/svg%3E"></div></td>
    </tr>
  </tbody></table>
  <button id="submit">Bestätigen</button>
</body>
</html>
"""


class BrowserHarness:
    """Exercise the production _snapshot_oopif_path control-flow against a real browser DOM."""

    def __init__(self, sb: SB) -> None:
        self.sb = sb
        self.oopif_scripts: list[str] = []

    def ares_oopif_evaluate(self, path: list[str], script: str, args: list[object]) -> dict[str, object]:
        if not path:
            raise AssertionError("Probe expected a non-empty OOPIF path")
        self.oopif_scripts.append(script)
        value = self.sb.driver.execute_script(script, *(args or []))
        return {
            "value": value,
            "frameId": "sprite-probe-frame",
            "documentEpoch": 1,
            "sessionGeneration": 1,
            "offsetX": 0.0,
            "offsetY": 0.0,
        }

    def evaluate(self, script: str) -> object:
        return self.sb.driver.execute_script("return (" + script + ");")


class ActionSite:
    _overrides: dict[str, str] = {}


def main() -> int:
    url = "data:text/html;charset=utf-8," + quote(HTML)
    with SB(browser="chrome", headless=True) as sb:
        sb.open(url)
        sb.driver.execute_script(
            "window.__clickedTiles=[];"
            "document.querySelectorAll('td[role=button]').forEach(el => "
            "el.addEventListener('click', () => window.__clickedTiles.push(el.id)));"
        )

        harness = BrowserHarness(sb)
        adapter = ScopeLockedGridSiteAdapter(harness)
        result = adapter._snapshot_oopif_path(["iframe[data-probe='sprite-grid']"])

        marks = [mark for mark in result.get("marks") or [] if isinstance(mark, dict)]
        selectors = [str(mark.get("selector") or "") for mark in marks]
        resolved = []
        for selector in selectors:
            selector_json = json.dumps(selector)
            resolved.append(
                sb.driver.execute_script(
                    "const el=document.querySelector(" + selector_json + ");"
                    "return el ? {tag:el.tagName,id:el.id,role:el.getAttribute('role')} : null;"
                )
            )

        executor = AuthorizedGridActionExecutor(harness, ActionSite())
        action_result = executor._apply_document([0, 5, 15], submit=False)
        clicked_dom = sb.driver.execute_script("return window.__clickedTiles.slice();")

    if result.get("kind") != "image-grid":
        raise AssertionError("Production OOPIF path did not detect the 4x4 sprite grid: " + json.dumps(result))
    if (int(result.get("rows") or 0), int(result.get("columns") or 0)) != (4, 4):
        raise AssertionError(f"Expected 4x4 grid, got {result.get('rows')}x{result.get('columns')}")
    if int(result.get("tileCount") or 0) != 16:
        raise AssertionError(f"Expected 16 tiles, got {result.get('tileCount')}")

    # This specifically proves the previously bypassing primary path is fixed:
    # _snapshot_oopif_path() must succeed on _OOPIF_GRID_SCRIPT itself, so the
    # subclass fallback never needs to run after the early return.
    if harness.oopif_scripts != [_OOPIF_GRID_SCRIPT]:
        raise AssertionError(
            "Expected the primary _OOPIF_GRID_SCRIPT to detect the sprite grid before fallback, "
            f"got {len(harness.oopif_scripts)} evaluated scripts"
        )

    if len(marks) != 16:
        raise AssertionError(f"Expected 16 stable marks, got {len(marks)}")
    expected_resolved = [
        {"tag": "TD", "id": str(index), "role": "button"}
        for index in range(16)
    ]
    if resolved != expected_resolved:
        raise AssertionError(
            "Expected every production-chain selector to resolve to its interactive td[role=button], "
            f"got selectors={selectors!r}, resolved={resolved!r}"
        )
    for mark in marks:
        bounds = mark.get("visualBounds") if isinstance(mark.get("visualBounds"), dict) else {}
        width = float(bounds.get("width") or 0.0)
        height = float(bounds.get("height") or 0.0)
        if not (94.0 <= width <= 97.0 and 94.0 <= height <= 97.0):
            raise AssertionError(f"Expected cell-sized ~95x95 bounds, got {bounds!r}")

    if action_result.get("clicked") != [0, 5, 15]:
        raise AssertionError(f"Expected action executor indexes [0,5,15], got {action_result!r}")
    if clicked_dom != ["0", "5", "15"]:
        raise AssertionError(f"Expected clicks on interactive TD cells 0,5,15, got {clicked_dom!r}")

    print(
        "PASS: production _snapshot_oopif_path primary script and action executor "
        "both resolve 4x4 sprite visuals to interactive cell geometry."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
