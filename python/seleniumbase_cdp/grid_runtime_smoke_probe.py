from __future__ import annotations

import json
import queue
import shutil
import socketserver
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import parse_qs, urlparse

from manual_profile_probe import WorkerClient


TARGETS = {
    "A": {0, 2, 4, 6, 8},
    "B": {1, 3, 5, 7},
}


class Recorder:
    def __init__(self) -> None:
        self.hits: queue.Queue[Dict[str, str]] = queue.Queue()


class SmokeHandler(BaseHTTPRequestHandler):
    recorder: Recorder

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/clicked":
            params = parse_qs(parsed.query)
            self.recorder.hits.put({
                "variant": (params.get("variant") or [""])[0],
                "index": (params.get("index") or [""])[0],
            })
            self._send(b"ok", "text/plain; charset=utf-8")
            return

        if parsed.path.startswith("/frame/"):
            variant = parsed.path.rsplit("/", 1)[-1]
            self._send(self._frame_html(variant).encode("utf-8"), "text/html; charset=utf-8")
            return

        if parsed.path.startswith("/case/"):
            variant = parsed.path.rsplit("/", 1)[-1]
            body = f"""<!doctype html>
<html><head><meta charset='utf-8'><title>ARES SigLIP Grid Smoke {variant}</title></head>
<body style='margin:0;background:#111;color:#fff;font-family:Arial'>
  <iframe id='challenge-frame' title='Visual selection task' src='/frame/{variant}'
    style='border:0;width:760px;height:720px;display:block;margin:20px auto'></iframe>
</body></html>""".encode("utf-8")
            self._send(body, "text/html; charset=utf-8")
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

    @staticmethod
    def _svg_data(index: int, variant: str) -> str:
        import base64

        is_target = index in TARGETS[variant]
        if variant == "A":
            if is_target:
                shape = "<rect x='34' y='34' width='112' height='112' rx='8' fill='#e11d48'/>"
                label = "RED SQUARE"
            else:
                shape = "<circle cx='90' cy='90' r='56' fill='#2563eb'/>"
                label = "BLUE CIRCLE"
        else:
            if is_target:
                shape = "<circle cx='90' cy='90' r='56' fill='#facc15'/>"
                label = "YELLOW CIRCLE"
            else:
                shape = "<polygon points='90,25 155,145 25,145' fill='#475569'/>"
                label = "GRAY TRIANGLE"

        svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>
<rect width='180' height='180' fill='white'/>{shape}
<text x='90' y='170' text-anchor='middle' font-family='Arial' font-size='13' fill='black'>{label}</text>
</svg>"""
        return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")

    @classmethod
    def _frame_html(cls, variant: str) -> str:
        tiles: List[str] = []
        for index in range(9):
            src = cls._svg_data(index, variant)
            tiles.append(
                f"<button class='tile' data-index='{index}' onclick=\"fetch('/clicked?variant={variant}&index={index}')\" "
                "style='padding:0;border:2px solid #fff;background:#000;width:180px;height:180px'>"
                f"<img src='{src}' alt='tile-{index}' style='display:block;width:176px;height:176px;object-fit:cover'></button>"
            )
        prompt = "Select all images with red squares" if variant == "A" else "Klicke alle Felder mit gelben Kreisen"
        grid = "".join(tiles)
        return f"""<!doctype html>
<html><head><meta charset='utf-8'><style>
body{{margin:0;background:#222;color:#fff;font-family:Arial;text-align:center}}
#grid{{display:grid;grid-template-columns:repeat(3,180px);gap:8px;justify-content:center;margin:18px auto}}
</style></head><body>
<div id='mount'><div id='waiting' style='padding:80px'>Preparing visual task...</div></div>
<script>
setTimeout(() => {{
  document.getElementById('mount').innerHTML = `<h2 class='instruction'>{prompt}</h2><div id='grid'>{grid}</div>`;
}}, 1400);
</script>
</body></html>"""

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def _start_server() -> tuple[socketserver.TCPServer, Recorder, str]:
    recorder = Recorder()

    class Handler(SmokeHandler):
        pass

    Handler.recorder = recorder
    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    return server, recorder, f"http://{host}:{port}"


def _wait_for_grid(client: WorkerClient, variant: str, timeout: float = 25.0) -> Dict[str, Any]:
    deadline = time.time() + timeout
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        request_id = f"grid-{variant}-{attempt}"
        client.send({"type": "site-grid-state", "requestId": request_id})
        message = client.wait("site-grid-state", request_id, 6)
        state = message.get("state") or {}
        if state.get("kind") == "image-grid" and int(state.get("tileCount") or 0) == 9:
            return state
        time.sleep(0.35)
    raise AssertionError(f"Variant {variant}: delayed 3x3 grid was not detected")


def _wait_for_siglip_action(profile_dir: Path, recorder: Recorder, variant: str, timeout: float = 35.0) -> None:
    trace = profile_dir / ".ares-visual-trace.jsonl"
    observations = profile_dir / ".ares-observations"
    clicked: set[int] = set()
    decision: Dict[str, Any] | None = None
    grid_result: Dict[str, Any] | None = None
    deadline = time.time() + timeout

    while time.time() < deadline:
        try:
            while True:
                hit = recorder.hits.get_nowait()
                if hit.get("variant") == variant:
                    clicked.add(int(hit.get("index") or -1))
        except queue.Empty:
            pass

        if trace.exists() and trace.stat().st_size > 0:
            for raw in trace.read_text(encoding="utf-8").splitlines():
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                payload = entry.get("payload") or {}
                if entry.get("phase") == "decision":
                    candidate = payload.get("decision") or {}
                    if candidate.get("model") == "google/siglip2-base-patch16-224":
                        decision = candidate
                if entry.get("phase") == "grid-screenshot-result":
                    candidate = payload.get("result") or {}
                    invariants = candidate.get("invariants") or {}
                    screenshot = candidate.get("screenshot") or {}
                    if (
                        int(invariants.get("tileCount") or 0) == 9
                        and int(invariants.get("markCount") or 0) == 9
                        and int(invariants.get("cropCount") or 0) == 9
                        and int(invariants.get("readable") or 0) == 9
                        and bool(invariants.get("geometryReady"))
                        and bool(invariants.get("cropsReady"))
                        and len(screenshot.get("cropBoxes") or []) == 9
                    ):
                        grid_result = candidate

        screenshots = list(observations.glob("*.png")) if observations.exists() else []
        screenshot_ok = any(path.stat().st_size > 0 for path in screenshots)
        if decision is not None and grid_result is not None and clicked and screenshot_ok:
            selected = {int(value) for value in decision.get("selectedIndexes") or []}
            expected = TARGETS[variant]
            if not selected:
                raise AssertionError(f"Variant {variant}: SigLIP2 returned no selected indexes: {decision}")
            wrong = selected - expected
            correct = selected & expected
            if wrong:
                raise AssertionError(f"Variant {variant}: SigLIP2 selected non-target tiles {sorted(wrong)}; decision={decision}")
            if len(correct) < 2:
                raise AssertionError(f"Variant {variant}: SigLIP2 selected too few correct target tiles: {decision}")
            if not clicked.issubset(expected):
                raise AssertionError(f"Variant {variant}: browser clicked non-target tiles {sorted(clicked - expected)}")
            if not clicked.intersection(correct):
                raise AssertionError(f"Variant {variant}: browser clicks do not match SigLIP2 decision; clicked={clicked}, decision={decision}")
            return

        time.sleep(0.35)

    trace_tail = trace.read_text(encoding="utf-8")[-6000:] if trace.exists() else "<missing trace>"
    raise AssertionError(
        f"Variant {variant}: no complete 9 marks -> screenshot -> 9 crops -> SigLIP2 -> click result within timeout. "
        f"clicked={sorted(clicked)} trace_tail={trace_tail}"
    )


def _run_variant(base_url: str, recorder: Recorder, root: Path, variant: str) -> None:
    profile_dir = root / f"profile-{variant}" / ".ares-seleniumbase-cdp"
    client = WorkerClient(profile_dir, f"{base_url}/case/{variant}")
    try:
        state = _wait_for_grid(client, variant)
        assert int(state.get("rows") or 0) == 3 and int(state.get("columns") or 0) == 3, state
        _wait_for_siglip_action(profile_dir, recorder, variant)
    finally:
        client.close()


def main() -> int:
    temporary = Path(tempfile.mkdtemp(prefix="ares-grid-runtime-smoke-"))
    server, recorder, base_url = _start_server()
    try:
        _run_variant(base_url, recorder, temporary, "A")
        _run_variant(base_url, recorder, temporary, "B")
        print("SeleniumBase delayed iframe grid smoke passed: 9 marks -> screenshot -> 9 crops -> real SigLIP2 -> trusted clicks.")
        return 0
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
