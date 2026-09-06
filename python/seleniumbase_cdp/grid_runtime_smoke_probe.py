from __future__ import annotations

import json
import os
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
            body = b"ok"
            self._send(body, "text/plain; charset=utf-8")
            return

        if parsed.path.startswith("/frame/"):
            variant = parsed.path.rsplit("/", 1)[-1]
            self._send(self._frame_html(variant).encode("utf-8"), "text/html; charset=utf-8")
            return

        if parsed.path.startswith("/case/"):
            variant = parsed.path.rsplit("/", 1)[-1]
            body = f"""<!doctype html>
<html><head><meta charset='utf-8'><title>ARES Grid Smoke {variant}</title></head>
<body style='margin:0;background:#111;color:#fff;font-family:Arial'>
  <iframe id='challenge-frame' title='Select all matching images' src='/frame/{variant}'
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
        palette_a = ["#db4437", "#4285f4", "#f4b400", "#0f9d58", "#8e44ad", "#e67e22", "#16a085", "#2c3e50", "#c0392b"]
        palette_b = ["#1f2937", "#334155", "#475569", "#64748b", "#0f172a", "#374151", "#4b5563", "#52525b", "#27272a"]
        palette = palette_a if variant == "A" else palette_b
        label = ("SIGN" if index in {0, 2, 4, 6, 8} else "ROAD") if variant == "B" else f"T{index+1}"
        svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>
<rect width='180' height='180' fill='{palette[index]}'/>
<circle cx='{40 + (index % 3) * 45}' cy='{50 + (index // 3) * 35}' r='24' fill='white' opacity='.82'/>
<text x='90' y='155' text-anchor='middle' font-family='Arial' font-size='24' fill='white'>{label}</text>
</svg>"""
        import base64
        return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")

    @classmethod
    def _frame_html(cls, variant: str) -> str:
        tiles: List[str] = []
        for index in range(9):
            src = cls._svg_data(index, variant)
            tiles.append(
                f"<button class='tile' data-index='{index}' onclick=\"fetch('/clicked?variant={variant}&index={index}')\" "
                "style='padding:0;border:2px solid #fff;background:#000;width:180px;height:180px'>"
                f"<img src='{src}' alt='tile-{index}' onclick=\"fetch('/clicked?variant={variant}&index={index}')\" "
                "style='display:block;width:176px;height:176px;object-fit:cover'></button>"
            )
        prompt = "Select all images with the requested object" if variant == "A" else "Klicke alle Felder mit dem passenden Verkehrszeichen"
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


def _wait_for_grid(client: WorkerClient, variant: str, timeout: float = 20.0) -> Dict[str, Any]:
    deadline = time.time() + timeout
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        request_id = f"grid-{variant}-{attempt}"
        client.send({"type": "site-grid-state", "requestId": request_id})
        message = client.wait("site-grid-state", request_id, 5)
        state = message.get("state") or {}
        if state.get("kind") == "image-grid" and int(state.get("tileCount") or 0) == 9:
            return state
        time.sleep(0.35)
    raise AssertionError(f"Variant {variant}: delayed 3x3 grid was not detected")


def _wait_for_visual_artifacts(profile_dir: Path, timeout: float = 15.0) -> tuple[Path, Path]:
    trace = profile_dir / ".ares-visual-trace.jsonl"
    observations = profile_dir / ".ares-observations"
    deadline = time.time() + timeout
    while time.time() < deadline:
        screenshots = list(observations.glob("*.png")) if observations.exists() else []
        if trace.exists() and trace.stat().st_size > 0 and any(path.stat().st_size > 0 for path in screenshots):
            return trace, screenshots[-1]
        time.sleep(0.25)
    raise AssertionError("Visual runtime did not produce trace + grid screenshot")


def _wait_for_click(recorder: Recorder, variant: str, timeout: float = 10.0) -> Dict[str, str]:
    deadline = time.time() + timeout
    seen: List[Dict[str, str]] = []
    while time.time() < deadline:
        try:
            hit = recorder.hits.get(timeout=0.4)
        except queue.Empty:
            continue
        seen.append(hit)
        if hit.get("variant") == variant:
            return hit
    raise AssertionError(f"Variant {variant}: grid click was not observed; seen={seen}")


def _run_variant(base_url: str, recorder: Recorder, root: Path, variant: str) -> None:
    profile_dir = root / f"profile-{variant}" / ".ares-seleniumbase-cdp"
    client = WorkerClient(profile_dir, f"{base_url}/case/{variant}")
    try:
        state = _wait_for_grid(client, variant)
        assert int(state.get("rows") or 0) == 3 and int(state.get("columns") or 0) == 3, state

        trace, screenshot = _wait_for_visual_artifacts(profile_dir)
        trace_text = trace.read_text(encoding="utf-8")
        if "grid-screenshot-captured" not in trace_text:
            raise AssertionError(f"Variant {variant}: trace did not record grid screenshot capture")
        if screenshot.stat().st_size <= 0:
            raise AssertionError(f"Variant {variant}: screenshot is empty")

        request_id = f"click-{variant}"
        client.send({"type": "apply-grid-selection", "requestId": request_id, "indexes": [0], "submit": False})
        result = client.wait("grid-selection-applied", request_id, 10)
        clicked = result.get("clickedIndexes") or result.get("clicked") or []
        if 0 not in [int(value) for value in clicked]:
            raise AssertionError(f"Variant {variant}: executor did not report tile 0 click: {result}")
        _wait_for_click(recorder, variant)
    finally:
        client.close()


def main() -> int:
    temporary = Path(tempfile.mkdtemp(prefix="ares-grid-runtime-smoke-"))
    server, recorder, base_url = _start_server()
    try:
        _run_variant(base_url, recorder, temporary, "A")
        _run_variant(base_url, recorder, temporary, "B")
        print("SeleniumBase delayed iframe grid smoke passed for variants A and B.")
        return 0
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
