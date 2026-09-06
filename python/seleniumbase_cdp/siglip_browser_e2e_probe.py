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


class RelativeSignalVisionClassifier(RobustVisionGridClassifier):
    """Test-only threshold-free SigLIP2 selector.

    Hugging Face's SigLIP2 zero-shot path accepts multiple text candidates for an
    image and exposes sigmoid(logits_per_image). For this validation probe each
    screenshot crop is therefore compared against a positive and negative text
    candidate and the stronger signal wins. No hidden target count or ground truth
    is passed to this classifier.
    """

    def classify(self, instruction: str, sources: Iterable[str]) -> Dict[str, Any]:
        if not self._load():
            return {
                "selectedIndexes": [],
                "scores": [],
                "negativeScores": [],
                "model": self.model_name,
                "error": self._error,
            }

        source_list = [str(source or "") for source in sources]
        target = self._target_text(instruction)
        texts = [
            f"This is a photo of {target}.",
            f"This is a photo without {target}.",
        ]

        loaded: List[Tuple[int, Any]] = []
        positive_scores: List[float | None] = [None] * len(source_list)
        negative_scores: List[float | None] = [None] * len(source_list)
        relative_margins: List[float | None] = [None] * len(source_list)
        for index, source in enumerate(source_list):
            image = self._read_image(source)
            if image is not None:
                loaded.append((index, image))

        if not loaded:
            return {
                "selectedIndexes": [],
                "scores": positive_scores,
                "negativeScores": negative_scores,
                "relativeMargins": relative_margins,
                "model": self.model_name,
                "target": target,
                "device": self._device,
                "error": "No readable grid images",
            }

        selected: List[int] = []
        try:
            inputs = self._processor(
                text=texts,
                images=[image for _, image in loaded],
                padding="max_length",
                max_length=64,
                truncation=True,
                return_tensors="pt",
            )
            inputs = {
                key: value.to(self._device) if hasattr(value, "to") else value
                for key, value in inputs.items()
            }
            with self._torch.inference_mode():
                outputs = self._model(**inputs)
            probabilities = self._torch.sigmoid(outputs.logits_per_image.float()).detach().cpu().tolist()

            if len(probabilities) != len(loaded):
                raise RuntimeError(
                    f"unexpected SigLIP2 image row count: {len(probabilities)} != {len(loaded)}"
                )

            for (source_index, _), row in zip(loaded, probabilities):
                if not isinstance(row, (list, tuple)) or len(row) < 2:
                    raise RuntimeError(f"unexpected SigLIP2 candidate score row: {row!r}")
                positive = float(row[0])
                negative = float(row[1])
                margin = positive - negative
                positive_scores[source_index] = round(positive, 4)
                negative_scores[source_index] = round(negative, 4)
                relative_margins[source_index] = round(margin, 4)
                if positive > negative:
                    selected.append(source_index)
        except Exception as exc:
            return {
                "selectedIndexes": [],
                "scores": positive_scores,
                "negativeScores": negative_scores,
                "relativeMargins": relative_margins,
                "model": self.model_name,
                "target": target,
                "device": self._device,
                "error": f"Relative SigLIP2 inference failed: {exc}",
            }

        ranking = sorted(
            (
                (float(score), index)
                for index, score in enumerate(positive_scores)
                if score is not None
            ),
            key=lambda item: (-item[0], item[1]),
        )
        return {
            "selectedIndexes": selected,
            "scores": positive_scores,
            "negativeScores": negative_scores,
            "relativeMargins": relative_margins,
            "positiveRanking": [index for _, index in ranking],
            "model": self.model_name,
            "target": target,
            "device": self._device,
            "selectionPolicy": "per-tile-strongest-positive-vs-negative-signal-test-only",
            "textCandidates": texts,
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


def _fixture(seed: int, target_category: int) -> Tuple[bytes, List[int], str]:
    rng = random.Random(seed)
    tiles: List[Dict[str, Any]] = []
    for category_index, label in enumerate(CATEGORIES):
        for variant in range(3):
            tiles.append({
                "category": category_index,
                "source": _tile_png(label, variant, seed ^ 0x5A17),
            })
    rng.shuffle(tiles)
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


def _collect(recorder: Recorder, timeout: float = 10.0) -> List[Dict[str, str]]:
    hits: List[Dict[str, str]] = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            hits.append(recorder.hits.get(timeout=0.3))
        except queue.Empty:
            if hits and any(hit.get("type") == "submit" for hit in hits):
                break
            continue
    return hits


def main() -> int:
    seed = _seed()
    root = Path(tempfile.mkdtemp(prefix="ares-siglip-e2e-"))
    adapter: SeleniumBaseCdpAdapter | None = None
    servers: List[socketserver.TCPServer] = []
    failures: List[str] = []
    print(f"SIGLIP_E2E_SEED={seed}")

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

        # One model instance is reused for every target category. Only the
        # selection policy is test-specific; screenshot capture, tile cropping,
        # grid execution, cursor planning and CDP input stay on the real ARES path.
        vision = RelativeSignalVisionClassifier()
        runtime = adapter._visual_interactions
        runtime._vision = vision
        runtime._controller._vision = vision

        for target_category, _ in enumerate(CATEGORIES):
            scenario_seed = seed ^ ((target_category + 1) * 0x9E3779B1)
            page, expected, target = _fixture(scenario_seed, target_category)
            server, recorder, url = _start_server(page)
            servers.append(server)

            # Ensure a previous scenario cannot be treated as already handled.
            runtime._controller._last_grid_signature = ""
            adapter.goto(url)

            hits = _collect(recorder)
            tile_hits = [
                int(hit["index"])
                for hit in hits
                if hit.get("type") == "tile" and str(hit.get("index") or "").isdigit()
            ]
            submit_hits = [hit for hit in hits if hit.get("type") == "submit"]
            state = adapter.auto_interaction_state()
            result = state.get("lastResult") if isinstance(state.get("lastResult"), dict) else {}
            decision = result.get("decision") if isinstance(result.get("decision"), dict) else {}
            action = result.get("result") if isinstance(result.get("result"), dict) else {}
            screenshot = result.get("screenshot") if isinstance(result.get("screenshot"), dict) else {}

            selected = sorted(int(value) for value in decision.get("selectedIndexes") or [])
            clicked = [int(value) for value in action.get("clickedIndexes") or []]

            print(
                "SIGLIP_E2E_DIAGNOSTIC "
                f"target={target!r} expected={expected} selected={selected} "
                f"ranking={decision.get('positiveRanking')} "
                f"positive={decision.get('scores')} negative={decision.get('negativeScores')} "
                f"margins={decision.get('relativeMargins')} clicked={clicked} "
                f"serverTiles={tile_hits} submitted={len(submit_hits)}"
            )

            checks = {
                "kind": result.get("kind") == "image-grid",
                "decision-source": result.get("decisionSource") == "screenshot-crops",
                "screenshot-first": result.get("screenshotFirst") is True,
                "all-crops-readable": int(screenshot.get("readable") or 0) == 12,
                "selection": selected == expected,
                "clicked": sorted(clicked) == expected,
                "server-clicks": sorted(tile_hits) == expected and len(tile_hits) == len(expected),
                "submit": len(submit_hits) == 1 and action.get("submitted") is True,
                "acted": result.get("acted") is True,
                "verified": result.get("verified") is True,
            }
            failed = [name for name, passed in checks.items() if not passed]
            if failed:
                failures.append(
                    f"target={target!r} failed={failed} expected={expected} selected={selected} "
                    f"ranking={decision.get('positiveRanking')} margins={decision.get('relativeMargins')} "
                    f"clicked={clicked} serverTiles={tile_hits} error={decision.get('error')!r}"
                )

            server.shutdown()
            server.server_close()
            servers.remove(server)

        if failures:
            raise AssertionError("SIGLIP_E2E_FAILURES\n" + "\n".join(failures))

        print(
            "PASS: all target classes completed real Chromium screenshot -> tile crops -> "
            "per-tile strongest SigLIP2 signal -> ARES CDP clicks -> HTTP server verification."
        )
        return 0
    finally:
        if adapter is not None:
            try:
                adapter.quit()
            except Exception:
                pass
        for server in servers:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
