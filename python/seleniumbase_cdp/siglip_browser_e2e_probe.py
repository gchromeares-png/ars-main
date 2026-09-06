from __future__ import annotations

import queue
import random
import shutil
import socketserver
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple
from urllib.parse import parse_qs, urlparse

from robust_vision_grid_classifier import RobustVisionGridClassifier
from seleniumbase_adapter import SeleniumBaseCdpAdapter
from siglip_randomized_grid_probe import CATEGORIES, _seed, _tile_png


class AdaptiveGapVisionClassifier(RobustVisionGridClassifier):
    """Test-only adaptive selector over real SigLIP2 scores.

    It deliberately receives no hidden labels or expected target count. The selected
    upper score cluster is derived only from the instruction and screenshot pixels.
    Production calibration remains unchanged until this policy is validated on real
    photo fixtures too.
    """

    def classify(self, instruction: str, sources: Iterable[str]) -> Dict[str, Any]:
        result = super().classify(instruction, sources)
        if result.get("error"):
            return result

        numeric: List[Tuple[float, int]] = []
        for index, value in enumerate(result.get("scores") or []):
            if value is None:
                continue
            try:
                numeric.append((float(value), index))
            except (TypeError, ValueError):
                continue
        if len(numeric) < 2:
            return {**result, "selectedIndexes": [], "adaptiveError": "insufficient-score-vector"}

        numeric.sort(key=lambda item: (-item[0], item[1]))
        max_upper = max(1, len(numeric) // 2)
        candidates: List[Tuple[float, int]] = []
        for split in range(1, min(max_upper, len(numeric) - 1) + 1):
            gap = numeric[split - 1][0] - numeric[split][0]
            candidates.append((gap, split))
        best_gap, split = max(candidates, key=lambda item: (item[0], -item[1]))

        spread = numeric[0][0] - numeric[-1][0]
        relative_gap = best_gap / spread if spread > 0 else 0.0
        minimum_gap = max(0.001, spread * 0.12)
        if best_gap <= minimum_gap or relative_gap < 0.12:
            selected: List[int] = []
        else:
            selected = sorted(index for _, index in numeric[:split])

        upper = numeric[split - 1][0]
        lower = numeric[split][0]
        return {
            **result,
            "selectedIndexes": selected,
            "selectionPolicy": "adaptive-largest-gap-test-only",
            "adaptiveGap": round(best_gap, 6),
            "adaptiveRelativeGap": round(relative_gap, 6),
            "adaptiveCutoff": round((upper + lower) / 2.0, 6),
            "fixedThresholdSelection": list(result.get("selectedIndexes") or []),
        }


class Recorder:
    def __init__(self) -> None:
        self.hits: queue.Queue[Dict[str, str]] = queue.Queue()


class FixtureHandler(BaseHTTPRequestHandler):
    recorder: Recorder
    page: bytes

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/clicked":
            params = parse_qs(parsed.query)
            self.recorder.hits.put({"type": "tile", "index": (params.get("index") or [""])[0]})
            self._send(b"ok", "text/plain; charset=utf-8")
            return
        if parsed.path == "/submitted":
            self.recorder.hits.put({"type": "submit", "index": ""})
            self._send(b"ok", "text/plain; charset=utf-8")
            return
        if parsed.path == "/":
            self._send(self.page, "text/html; charset=utf-8")
            return
        self.send_response(404)
        self.end_headers()

    def _send(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def _fixture(seed: int) -> Tuple[bytes, List[int], str]:
    rng = random.Random(seed)
    tiles: List[Dict[str, Any]] = []
    for category_index, label in enumerate(CATEGORIES):
        for variant in range(3):
            tiles.append({
                "category": category_index,
                "source": _tile_png(label, variant, seed ^ 0x5A17),
            })
    rng.shuffle(tiles)
    target_category = rng.randrange(len(CATEGORIES))
    target = CATEGORIES[target_category]
    expected = sorted(index for index, tile in enumerate(tiles) if tile["category"] == target_category)

    tile_html = "".join(
        "<button class='tile' type='button' "
        f"onclick=\"fetch('/clicked?index={index}')\">"
        f"<img src='{tile['source']}' alt='' draggable='false'>"
        "</button>"
        for index, tile in enumerate(tiles)
    )
    page = f"""<!doctype html>
<html>
<head>
<meta charset='utf-8'>
<style>
html,body{{margin:0;padding:0;background:#fff;color:#111;font-family:Arial,sans-serif}}
main{{padding:18px}}
#instruction{{font-size:22px;margin:0 0 14px}}
#grid{{display:grid;grid-template-columns:repeat(4,144px);gap:10px;width:max-content}}
.tile{{width:144px;height:144px;padding:0;border:1px solid #aaa;background:#fff;overflow:hidden}}
.tile img{{display:block;width:144px;height:144px;object-fit:cover}}
#submit{{margin-top:14px;padding:10px 22px;font-size:16px}}
</style>
<script>
function finishGrid(){{
  fetch('/submitted');
  const grid=document.getElementById('grid'); if(grid) grid.remove();
  const submit=document.getElementById('submit'); if(submit) submit.remove();
  const done=document.getElementById('done'); if(done) done.hidden=false;
}}
</script>
</head>
<body><main>
<h2 id='instruction'>Select all images with {target}</h2>
<div id='grid'>{tile_html}</div>
<button id='submit' type='button' onclick='finishGrid()'>Submit</button>
<div id='done' hidden>Selection submitted</div>
</main></body>
</html>""".encode("utf-8")
    return page, expected, target


def _start_server(page: bytes) -> Tuple[socketserver.TCPServer, Recorder, str]:
    recorder = Recorder()

    class Handler(FixtureHandler):
        pass

    Handler.recorder = recorder
    Handler.page = page
    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    return server, recorder, f"http://{host}:{port}/"


def _collect(recorder: Recorder, expected_count: int, timeout: float = 20.0) -> List[Dict[str, str]]:
    hits: List[Dict[str, str]] = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and len(hits) < expected_count:
        try:
            hits.append(recorder.hits.get(timeout=0.4))
        except queue.Empty:
            continue
    return hits


def main() -> int:
    seed = _seed()
    page, expected, target = _fixture(seed)
    server, recorder, url = _start_server(page)
    root = Path(tempfile.mkdtemp(prefix="ares-siglip-e2e-"))
    adapter: SeleniumBaseCdpAdapter | None = None
    print(f"SIGLIP_E2E_SEED={seed} target={target!r} expected={expected}")

    try:
        adapter = SeleniumBaseCdpAdapter(
            profile_dir=root / "profile",
            headless=True,
            site_adapter_overrides={
                "root": "#grid",
                "tiles": ".tile",
                "submit": "#submit",
                "instruction": "#instruction",
            },
        )

        # Inject only the selection policy used by this validation probe. The rest
        # of the path is the real production VisualInteractionRuntime, screenshot
        # crop provider, controller, grid executor, cursor planning and CDP input.
        vision = AdaptiveGapVisionClassifier()
        runtime = adapter._visual_interactions
        runtime._vision = vision
        runtime._controller._vision = vision

        adapter.goto(url)

        hits = _collect(recorder, len(expected) + 1)
        tile_hits = [int(hit["index"]) for hit in hits if hit.get("type") == "tile" and str(hit.get("index") or "").isdigit()]
        submit_hits = [hit for hit in hits if hit.get("type") == "submit"]
        state = adapter.auto_interaction_state()
        result = state.get("lastResult") if isinstance(state.get("lastResult"), dict) else {}
        decision = result.get("decision") if isinstance(result.get("decision"), dict) else {}
        action = result.get("result") if isinstance(result.get("result"), dict) else {}
        screenshot = result.get("screenshot") if isinstance(result.get("screenshot"), dict) else {}

        selected = sorted(int(value) for value in decision.get("selectedIndexes") or [])
        clicked = [int(value) for value in action.get("clickedIndexes") or []]

        assert result.get("kind") == "image-grid", result
        assert result.get("decisionSource") == "screenshot-crops", result
        assert result.get("screenshotFirst") is True, result
        assert int(screenshot.get("readable") or 0) == 12, screenshot
        assert selected == expected, (decision, expected)
        assert sorted(clicked) == expected, (action, expected)
        assert sorted(tile_hits) == expected, (hits, expected)
        assert len(tile_hits) == len(expected), hits
        assert len(submit_hits) == 1, hits
        assert action.get("submitted") is True, action
        assert result.get("acted") is True, result
        assert result.get("verified") is True, result

        print(
            "SIGLIP_E2E_RESULT "
            f"target={target!r} selected={selected} clicked={clicked} "
            f"serverTiles={tile_hits} submitted={len(submit_hits)} "
            f"adaptiveGap={decision.get('adaptiveGap')} "
            f"adaptiveCutoff={decision.get('adaptiveCutoff')} "
            f"fixedThresholdSelection={decision.get('fixedThresholdSelection')}"
        )
        print(
            "PASS: real Chromium screenshot -> tile crops -> SigLIP2 pixels-only decision -> "
            "ARES CDP grid clicks -> HTTP server verification completed end to end."
        )
        return 0
    finally:
        if adapter is not None:
            try:
                adapter.quit()
            except Exception:
                pass
        server.shutdown()
        server.server_close()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
