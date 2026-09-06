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


class RankedGroundedVisionClassifier(RobustVisionGridClassifier):
    """Test-only hybrid: SigLIP2 ranking plus Grounding DINO presence checks.

    SigLIP2 supplies the target-relative ordering that has stayed correct across the
    randomized browser crops. Grounding DINO is used only to decide whether the
    requested open-set object is actually present in each crop, so this probe does
    not need a hidden target count, a fixed top-k, or the discarded negation prompt.

    Grounding DINO invocation and the 0.4 / 0.3 post-processing thresholds match the
    official Hugging Face Transformers Grounding DINO zero-shot example.
    """

    DINO_MODEL = "IDEA-Research/grounding-dino-tiny"
    DINO_BOX_THRESHOLD = 0.4
    DINO_TEXT_THRESHOLD = 0.3

    def __init__(self) -> None:
        super().__init__()
        self._dino_processor: Any = None
        self._dino_model: Any = None
        self._dino_error = ""

    def _load_dino(self) -> bool:
        if self._dino_model is not None:
            return True
        if self._dino_error:
            return False
        try:
            from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

            self._dino_processor = AutoProcessor.from_pretrained(self.DINO_MODEL)
            self._dino_model = AutoModelForZeroShotObjectDetection.from_pretrained(self.DINO_MODEL)
            self._dino_model.to(self._device)
            self._dino_model.eval()
            return True
        except Exception as exc:
            self._dino_error = f"Grounding DINO unavailable: {exc}"
            return False

    def classify(self, instruction: str, sources: Iterable[str]) -> Dict[str, Any]:
        # First run the production SigLIP2 classifier unchanged. We keep its raw
        # positive scores only for ranking/diagnostics; its fixed 0.58 selection is
        # deliberately ignored in this validation probe.
        siglip = super().classify(instruction, sources)
        if siglip.get("error"):
            return {
                **siglip,
                "selectedIndexes": [],
                "selectionPolicy": "siglip-ranking-grounding-dino-confirmation-test-only",
            }
        if not self._load_dino():
            return {
                **siglip,
                "selectedIndexes": [],
                "selectionPolicy": "siglip-ranking-grounding-dino-confirmation-test-only",
                "error": self._dino_error,
            }

        source_list = [str(source or "") for source in sources]
        target = self._target_text(instruction)
        loaded: List[Tuple[int, Any]] = []
        for index, source in enumerate(source_list):
            image = self._read_image(source)
            if image is not None:
                loaded.append((index, image))

        if not loaded:
            return {
                **siglip,
                "selectedIndexes": [],
                "selectionPolicy": "siglip-ranking-grounding-dino-confirmation-test-only",
                "error": "No readable grid images for Grounding DINO",
            }

        siglip_scores = list(siglip.get("scores") or [])
        ranking = sorted(
            (
                (float(score), index)
                for index, score in enumerate(siglip_scores)
                if score is not None
            ),
            key=lambda item: (-item[0], item[1]),
        )

        dino_scores: List[float | None] = [None] * len(source_list)
        dino_detection_counts: List[int] = [0] * len(source_list)
        selected: List[int] = []
        try:
            images = [image for _, image in loaded]
            text_labels = [[target] for _ in images]
            inputs = self._dino_processor(images=images, text=text_labels, return_tensors="pt")
            inputs = {
                key: value.to(self._device) if hasattr(value, "to") else value
                for key, value in inputs.items()
            }
            with self._torch.inference_mode():
                outputs = self._dino_model(**inputs)

            target_sizes = [image.size[::-1] for image in images]
            results = self._dino_processor.post_process_grounded_object_detection(
                outputs,
                inputs["input_ids"],
                threshold=self.DINO_BOX_THRESHOLD,
                text_threshold=self.DINO_TEXT_THRESHOLD,
                target_sizes=target_sizes,
            )
            if len(results) != len(loaded):
                raise RuntimeError(
                    f"unexpected Grounding DINO result count: {len(results)} != {len(loaded)}"
                )

            for (source_index, _), result in zip(loaded, results):
                scores = result.get("scores") if isinstance(result, dict) else None
                if scores is None:
                    values: List[float] = []
                elif hasattr(scores, "detach"):
                    values = [float(value) for value in scores.detach().cpu().tolist()]
                else:
                    values = [float(value) for value in list(scores)]
                dino_detection_counts[source_index] = len(values)
                dino_scores[source_index] = round(max(values), 4) if values else 0.0
                if values:
                    selected.append(source_index)
        except Exception as exc:
            return {
                **siglip,
                "selectedIndexes": [],
                "positiveRanking": [index for _, index in ranking],
                "groundingDinoScores": dino_scores,
                "groundingDinoDetectionCounts": dino_detection_counts,
                "groundingDinoModel": self.DINO_MODEL,
                "selectionPolicy": "siglip-ranking-grounding-dino-confirmation-test-only",
                "error": f"Grounding DINO inference failed: {exc}",
            }

        return {
            **siglip,
            "selectedIndexes": sorted(selected),
            "positiveRanking": [index for _, index in ranking],
            "groundingDinoScores": dino_scores,
            "groundingDinoDetectionCounts": dino_detection_counts,
            "groundingDinoModel": self.DINO_MODEL,
            "groundingDinoBoxThreshold": self.DINO_BOX_THRESHOLD,
            "groundingDinoTextThreshold": self.DINO_TEXT_THRESHOLD,
            "selectionPolicy": "siglip-ranking-grounding-dino-confirmation-test-only",
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


def _collect(recorder: Recorder, timeout: float = 12.0) -> List[Dict[str, str]]:
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

        vision = RankedGroundedVisionClassifier()
        runtime = adapter._visual_interactions
        runtime._vision = vision
        runtime._controller._vision = vision

        for target_category, _ in enumerate(CATEGORIES):
            scenario_seed = seed ^ ((target_category + 1) * 0x9E3779B1)
            page, expected, target = _fixture(scenario_seed, target_category)
            server, recorder, url = _start_server(page)
            servers.append(server)

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
                "SIGLIP_DINO_E2E_DIAGNOSTIC "
                f"target={target!r} expected={expected} selected={selected} "
                f"siglipRanking={decision.get('positiveRanking')} "
                f"siglipScores={decision.get('scores')} "
                f"dinoScores={decision.get('groundingDinoScores')} "
                f"dinoCounts={decision.get('groundingDinoDetectionCounts')} "
                f"clicked={clicked} serverTiles={tile_hits} submitted={len(submit_hits)} "
                f"error={decision.get('error')!r}"
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
                    f"siglipRanking={decision.get('positiveRanking')} "
                    f"dinoScores={decision.get('groundingDinoScores')} "
                    f"dinoCounts={decision.get('groundingDinoDetectionCounts')} "
                    f"clicked={clicked} serverTiles={tile_hits} error={decision.get('error')!r}"
                )

            server.shutdown()
            server.server_close()
            servers.remove(server)

        if failures:
            raise AssertionError("SIGLIP_DINO_E2E_FAILURES\n" + "\n".join(failures))

        print(
            "PASS: all target classes completed real Chromium screenshot -> tile crops -> "
            "SigLIP2 ranking -> Grounding DINO open-set confirmation -> ARES CDP clicks -> "
            "HTTP server verification."
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
