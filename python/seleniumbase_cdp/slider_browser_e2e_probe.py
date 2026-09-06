from __future__ import annotations

import base64
import io
import os
import queue
import random
import shutil
import socketserver
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageDraw

from seleniumbase_adapter import SeleniumBaseCdpAdapter


class Recorder:
    def __init__(self) -> None:
        self.hits: queue.Queue[Dict[str, str]] = queue.Queue()


class FixtureHandler(BaseHTTPRequestHandler):
    recorder: Recorder
    page: bytes

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in {"/verified", "/failed"}:
            params = parse_qs(parsed.query)
            self.recorder.hits.put(
                {
                    "type": parsed.path.lstrip("/"),
                    "fraction": (params.get("fraction") or [""])[0],
                    "trusted": (params.get("trusted") or [""])[0],
                }
            )
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


def _seed() -> int:
    raw = os.environ.get("ARES_SLIDER_TEST_SEED", "").strip()
    if raw:
        try:
            return int(raw, 0)
        except ValueError:
            pass
    return int.from_bytes(os.urandom(8), "big")


def _png_uri(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _assets(seed: int) -> Tuple[str, str, float, int, int]:
    rng = random.Random(seed)
    width, height = 360, 180
    source = Image.new("RGB", (width, height))
    pixels = source.load()

    # Deterministic textured scene: every crop has enough local detail for a real
    # image matcher without exposing the hidden target position to ARES.
    for y in range(height):
        for x in range(width):
            jitter = ((x * 37 + y * 19 + seed) ^ (x * y * 3)) & 31
            if y < 78:
                pixels[x, y] = (115 + jitter, 160 + jitter // 2, 205 + jitter // 3)
            else:
                pixels[x, y] = (92 + jitter // 2, 132 + jitter, 78 + jitter // 3)

    draw = ImageDraw.Draw(source)
    draw.polygon([(0, 92), (80, 52), (165, 96), (245, 44), (360, 88), (360, 135), (0, 135)], fill=(72, 108, 68))
    draw.rectangle((0, 132, width, height), fill=(72, 76, 82))
    draw.polygon([(30, 180), (145, 132), (210, 132), (330, 180)], fill=(112, 116, 121))
    for lane in (0.42, 0.58):
        x = int(width * lane)
        draw.line((x, 132, x + (25 if lane < 0.5 else -25), 180), fill=(232, 232, 220), width=3)
    for _ in range(14):
        x = rng.randint(5, width - 18)
        y = rng.randint(12, 122)
        r = rng.randint(3, 9)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(40 + rng.randint(0, 90), 70 + rng.randint(0, 100), 45 + rng.randint(0, 70)))

    piece_size = 48
    target_x = rng.randint(115, width - piece_size - 55)
    target_y = rng.randint(58, 105)
    piece = source.crop((target_x, target_y, target_x + piece_size, target_y + piece_size))

    background = source.copy()
    marker = ImageDraw.Draw(background)
    # Draw only around the matching region; the pixels inside remain unchanged so
    # the local matcher must find the actual rendered patch rather than read metadata.
    marker.rectangle(
        (target_x - 4, target_y - 4, target_x + piece_size + 3, target_y + piece_size + 3),
        outline=(242, 245, 246),
        width=3,
    )
    marker.rectangle(
        (target_x - 7, target_y - 7, target_x + piece_size + 6, target_y + piece_size + 6),
        outline=(45, 48, 52),
        width=2,
    )

    target_fraction = target_x / float(width - piece_size)
    return _png_uri(background), _png_uri(piece), target_fraction, target_x, target_y


def _fixture(seed: int) -> Tuple[bytes, float]:
    background_uri, piece_uri, target_fraction, _target_x, _target_y = _assets(seed)
    page = f"""<!doctype html>
<html>
<head>
<meta charset='utf-8'>
<style>
html,body{{margin:0;padding:0;background:#f3f3f3;color:#161616;font-family:Arial,sans-serif}}
main{{padding:24px}}
#slider-fixture{{width:430px;background:#fff;border:1px solid #ccc;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.08)}}
#instruction{{font-size:18px;margin:0 0 12px}}
#puzzle-background{{display:block;width:360px;height:180px;object-fit:fill;border:1px solid #b7b7b7}}
.piece-row{{height:58px;display:flex;align-items:center;gap:10px;margin-top:8px;font-size:13px;color:#555}}
#puzzle-piece{{display:block;width:48px;height:48px;object-fit:fill;border:1px solid #777}}
#track{{position:relative;width:320px;height:44px;margin-top:12px;background:#e9e9e9;border:1px solid #bdbdbd;border-radius:3px;user-select:none}}
#handle{{position:absolute;left:0;top:0;width:44px;height:44px;background:#d9d9d9;border-right:1px solid #aaa;cursor:grab;box-sizing:border-box}}
#handle:after{{content:'➤';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;color:#555}}
#status{{margin-top:9px;height:20px;font-size:13px;color:#555}}
</style>
</head>
<body><main>
<div id='slider-fixture'>
  <div id='instruction'>Bewege den Regler an die passende Position.</div>
  <img id='puzzle-background' class='puzzle-background' src='{background_uri}' alt=''>
  <div class='piece-row'><img id='puzzle-piece' class='puzzle-piece' src='{piece_uri}' alt=''><span>Passendes Bildstück</span></div>
  <div id='track' class='slider-track'>
    <div id='handle' class='slider-handle' role='slider' aria-valuemin='0' aria-valuemax='100' aria-valuenow='0'></div>
  </div>
  <div id='status'>Position finden und ziehen</div>
</div>
<script>
(() => {{
  const target = {target_fraction:.10f};
  const track = document.getElementById('track');
  const handle = document.getElementById('handle');
  const status = document.getElementById('status');
  let dragging = false;
  let trustedStart = false;
  let fraction = 0;

  const update = clientX => {{
    const r = track.getBoundingClientRect();
    fraction = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    handle.style.left = Math.max(0, Math.min(r.width - handle.offsetWidth, fraction * r.width - handle.offsetWidth / 2)) + 'px';
    handle.setAttribute('aria-valuenow', String(fraction * 100));
  }};

  handle.addEventListener('mousedown', event => {{
    dragging = true;
    trustedStart = event.isTrusted === true;
    update(event.clientX);
    event.preventDefault();
  }});
  document.addEventListener('mousemove', event => {{
    if (!dragging) return;
    update(event.clientX);
  }});
  document.addEventListener('mouseup', event => {{
    if (!dragging) return;
    update(event.clientX);
    dragging = false;
    const trusted = trustedStart && event.isTrusted === true;
    const ok = trusted && Math.abs(fraction - target) <= 0.075;
    if (ok) {{
      status.textContent = 'Position bestätigt';
      const done = document.createElement('div');
      done.id = 'done';
      done.hidden = true;
      document.getElementById('slider-fixture').appendChild(done);
      fetch('/verified?fraction=' + encodeURIComponent(fraction.toFixed(6)) + '&trusted=1');
    }} else {{
      status.textContent = 'Position nicht bestätigt';
      fetch('/failed?fraction=' + encodeURIComponent(fraction.toFixed(6)) + '&trusted=' + (trusted ? '1' : '0'));
    }}
  }});
}})();
</script>
</main></body>
</html>""".encode("utf-8")
    return page, target_fraction


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


def _collect(recorder: Recorder, timeout: float = 3.0) -> List[Dict[str, str]]:
    hits: List[Dict[str, str]] = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            hits.append(recorder.hits.get(timeout=0.2))
        except queue.Empty:
            if hits:
                break
    return hits


def main() -> int:
    seed = _seed()
    page, expected_fraction = _fixture(seed)
    root = Path(tempfile.mkdtemp(prefix="ares-slider-e2e-"))
    server, recorder, url = _start_server(page)
    adapter: SeleniumBaseCdpAdapter | None = None
    print(f"SLIDER_E2E_SEED={seed} expectedFraction={expected_fraction:.6f}")

    try:
        adapter = SeleniumBaseCdpAdapter(
            profile_dir=root / "profile",
            headless=True,
            site_adapter_overrides={
                "sliderRoot": "#slider-fixture",
                "sliderHandle": "#handle",
                "sliderTrack": "#track",
                "sliderInstruction": "#instruction",
                "sliderComplete": "#done",
            },
        )
        adapter.goto(url)

        deadline = time.monotonic() + 8.0
        result: Dict[str, Any] = {}
        while time.monotonic() < deadline:
            state = adapter.auto_interaction_state()
            candidate = state.get("lastResult")
            if isinstance(candidate, dict):
                result = candidate
                if candidate.get("kind") == "slider" and (candidate.get("acted") or candidate.get("reason") in {"complete", "failed"}):
                    break
            adapter.poll_runtime()
            time.sleep(0.15)

        hits = _collect(recorder)
        verified_hits = [hit for hit in hits if hit.get("type") == "verified"]
        failed_hits = [hit for hit in hits if hit.get("type") == "failed"]
        target = result.get("target") if isinstance(result.get("target"), dict) else {}
        action = result.get("result") if isinstance(result.get("result"), dict) else {}
        verification = result.get("verification") if isinstance(result.get("verification"), dict) else {}
        grounded_fraction = float(target.get("targetFraction") or -1.0)
        actual_fraction = float(verified_hits[0].get("fraction") or -1.0) if verified_hits else -1.0

        print(
            "SLIDER_E2E_DIAGNOSTIC "
            f"source={target.get('source')!r} groundedFraction={grounded_fraction:.6f} "
            f"expectedFraction={expected_fraction:.6f} actionMode={action.get('mode')!r} "
            f"acted={result.get('acted')} verified={result.get('verified')} "
            f"verificationReason={verification.get('reason')!r} serverFraction={actual_fraction:.6f} "
            f"trusted={(verified_hits[0].get('trusted') if verified_hits else None)!r} failedHits={len(failed_hits)}"
        )

        assert result.get("kind") == "slider", result
        assert target.get("source") == "ddddocr-slide-match", target
        assert abs(grounded_fraction - expected_fraction) <= 0.08, (target, expected_fraction)
        assert result.get("acted") is True, result
        assert result.get("verified") is True, result
        assert str(action.get("mode") or "").startswith("path:"), action
        assert str(action.get("mode") or "").endswith(":cdp"), action
        assert len(verified_hits) == 1 and verified_hits[0].get("trusted") == "1", hits
        assert not failed_hits, hits
        assert abs(actual_fraction - expected_fraction) <= 0.08, (actual_fraction, expected_fraction)

        print(
            "PASS: rendered puzzle assets -> local ddddocr match -> ARES slider grounding -> "
            "Bezier/GhostCursor CDP drag -> trusted browser event -> HTTP verification."
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
