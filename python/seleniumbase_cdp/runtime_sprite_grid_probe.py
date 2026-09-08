from __future__ import annotations

import json
from urllib.parse import quote

from seleniumbase import SB

from runtime_oopif_grid_site_adapter import RUNTIME_OOPIF_GRID_SCRIPT


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


def main() -> int:
    url = "data:text/html;charset=utf-8," + quote(HTML)
    with SB(browser="chrome", headless=True) as sb:
        sb.open(url)
        result = sb.execute_script(RUNTIME_OOPIF_GRID_SCRIPT)

    if not isinstance(result, dict):
        raise AssertionError(f"Runtime sprite probe returned non-object: {type(result).__name__}")
    if result.get("kind") != "image-grid":
        raise AssertionError("Runtime sprite probe did not detect the 4x4 grid: " + json.dumps(result))
    if (int(result.get("rows") or 0), int(result.get("columns") or 0)) != (4, 4):
        raise AssertionError(f"Expected 4x4 grid, got {result.get('rows')}x{result.get('columns')}")
    if int(result.get("tileCount") or 0) != 16:
        raise AssertionError(f"Expected 16 tiles, got {result.get('tileCount')}")

    marks = [mark for mark in result.get("rawMarks") or [] if isinstance(mark, dict)]
    if len(marks) != 16:
        raise AssertionError(f"Expected 16 raw marks, got {len(marks)}")
    selectors = [str(mark.get("selector") or "") for mark in marks]
    if selectors != [f"#{index}" for index in range(16)]:
        raise AssertionError(f"Expected interactive td selectors #0..#15, got {selectors!r}")
    for mark in marks:
        bounds = mark.get("visualBounds") if isinstance(mark.get("visualBounds"), dict) else {}
        width = float(bounds.get("width") or 0.0)
        height = float(bounds.get("height") or 0.0)
        if not (94.0 <= width <= 97.0 and 94.0 <= height <= 97.0):
            raise AssertionError(f"Expected cell-sized ~95x95 bounds, got {bounds!r}")

    print("PASS: 4x4 sprite visuals resolve to interactive cell geometry, not shifted sprite-image bounds.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
