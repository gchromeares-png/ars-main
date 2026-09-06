from __future__ import annotations

import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict

from robust_vision_grid_classifier import RobustVisionGridClassifier
from vision_runtime_bootstrap import ensure_dependencies


MAX_BODY = 24 * 1024 * 1024
DEFAULT_PRELOAD_WAIT_SECONDS = 600.0


class VisionService:
    def __init__(self, token: str) -> None:
        self.token = token
        self.classifier = RobustVisionGridClassifier(allow_remote=False)
        self._requests = 0
        self._lock = threading.Lock()
        self._preload_started = False
        self._preload_done = threading.Event()
        self._preload_error = ""

    def authorize(self, header: str) -> bool:
        return bool(self.token) and header == f"Bearer {self.token}"

    def preload_async(self, *, auto_prepare: bool = False) -> None:
        with self._lock:
            if self._preload_started:
                return
            self._preload_started = True

        def run() -> None:
            error = ""
            try:
                if auto_prepare:
                    dependencies = ensure_dependencies()
                    if not dependencies.get("dependenciesReady"):
                        raise RuntimeError(str(dependencies.get("error") or "Vision dependencies are unavailable"))
                if not self.classifier.ready:
                    raise RuntimeError(self.classifier.error or "SigLIP model preload failed")
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
            finally:
                with self._lock:
                    self._preload_error = error
                self._preload_done.set()

        threading.Thread(target=run, name="ares-vision-preload", daemon=True).start()

    def _wait_for_preload(self) -> None:
        with self._lock:
            started = self._preload_started
        if not started:
            return
        try:
            timeout = float(os.environ.get("ARES_VISION_PRELOAD_WAIT_SECONDS", str(DEFAULT_PRELOAD_WAIT_SECONDS)))
        except ValueError:
            timeout = DEFAULT_PRELOAD_WAIT_SECONDS
        if not self._preload_done.wait(max(1.0, timeout)):
            raise TimeoutError("shared SigLIP preload did not finish before inference deadline")
        with self._lock:
            error = self._preload_error
        if error:
            raise RuntimeError(f"shared SigLIP preload failed: {error}")

    def health(self) -> Dict[str, Any]:
        with self._lock:
            requests = self._requests
            preload_started = self._preload_started
            preload_error = self._preload_error
        if preload_started and not self._preload_done.is_set():
            return {
                "ready": False,
                "model": self.classifier.model_name,
                "device": "preparing",
                "error": "",
                "service": "ares-shared-vision",
                "requests": requests,
                "preloadStarted": True,
                "preparing": True,
            }
        if preload_error:
            return {
                "ready": False,
                "model": self.classifier.model_name,
                "device": "unknown",
                "error": preload_error,
                "service": "ares-shared-vision",
                "requests": requests,
                "preloadStarted": preload_started,
                "preparing": False,
            }
        value = self.classifier.status()
        return {
            **value,
            "service": "ares-shared-vision",
            "requests": requests,
            "preloadStarted": preload_started,
            "preparing": False,
        }

    def classify(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        instruction = str(payload.get("instruction") or "")
        raw_sources = payload.get("sources")
        if not isinstance(raw_sources, list):
            raise TypeError("sources must be an array")
        if len(raw_sources) > 64:
            raise ValueError("vision request exceeds 64 tiles")
        sources = [str(value or "") for value in raw_sources]
        self._wait_for_preload()
        with self._lock:
            self._requests += 1
        return self.classifier.classify(instruction, sources)


def handler_for(service: VisionService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ARES-Vision/1"

        def log_message(self, _format: str, *args: Any) -> None:
            return

        def _json(self, status: int, payload: Dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            if service.authorize(str(self.headers.get("Authorization") or "")):
                return True
            self._json(403, {"error": "forbidden"})
            return False

        def do_GET(self) -> None:
            if self.path != "/health":
                self._json(404, {"error": "not-found"})
                return
            if not self._authorized():
                return
            self._json(200, service.health())

        def do_POST(self) -> None:
            if self.path != "/classify":
                self._json(404, {"error": "not-found"})
                return
            if not self._authorized():
                return
            try:
                length = int(self.headers.get("Content-Length") or "0")
                if length <= 0 or length > MAX_BODY:
                    raise ValueError("invalid request size")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise TypeError("request must be a JSON object")
                result = service.classify(payload)
                self._json(200, result)
            except Exception as exc:
                self._json(400, {"error": f"{type(exc).__name__}: {exc}"})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    parser.add_argument("--preload", action="store_true")
    parser.add_argument("--auto-prepare", action="store_true")
    args = parser.parse_args()

    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("shared vision service must bind to loopback")

    service = VisionService(str(args.token))
    server = ThreadingHTTPServer((args.host, args.port), handler_for(service))
    host, port = server.server_address[:2]

    # Publish the listener before dependency/model preparation. The owning Node
    # worker can hand URL/token to session processes immediately while warmup
    # overlaps browser startup and navigation. First inference waits for the
    # same warmup instead of racing a second model load.
    print(json.dumps({
        "ready": True,
        "url": f"http://{host}:{port}",
        "model": service.classifier.model_name,
        "preloading": bool(args.preload),
        "autoPrepare": bool(args.auto_prepare),
        "selectionPolicy": "prompt-ensemble-raw-logit",
    }), flush=True)
    if args.preload:
        service.preload_async(auto_prepare=args.auto_prepare)

    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
