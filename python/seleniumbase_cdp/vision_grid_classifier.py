from __future__ import annotations

import base64
import io
import os
import re
import threading
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List


DEFAULT_PROBABILITY_THRESHOLD = 0.5


class VisionGridClassifier:
    """SigLIP2 zero-shot grid classifier using the Hugging Face reference inference path."""

    def __init__(self, *, allow_remote: bool = True) -> None:
        self.model_name = os.environ.get("ARES_VISION_MODEL", "google/siglip2-base-patch16-224").strip()
        self.threshold = self._probability_threshold(
            os.environ.get("ARES_VISION_PROB_THRESHOLD", str(DEFAULT_PROBABILITY_THRESHOLD))
        )
        self.offline = os.environ.get("ARES_VISION_OFFLINE", "0").strip() == "1"
        self.remote_url = os.environ.get("ARES_VISION_SERVICE_URL", "").strip() if allow_remote else ""
        self.remote_token = os.environ.get("ARES_VISION_SERVICE_TOKEN", "").strip() if allow_remote else ""
        self._processor: Any = None
        self._model: Any = None
        self._torch: Any = None
        self._image: Any = None
        self._device = "cpu"
        self._error = ""
        self._lock = threading.RLock()

    @property
    def ready(self) -> bool:
        if self.remote_url:
            return self._remote_health()
        return self._load()

    @property
    def error(self) -> str:
        return self._error

    def status(self) -> Dict[str, Any]:
        ready = self.ready
        return {
            "ready": ready,
            "model": self.model_name,
            "threshold": self.threshold,
            "selectionPolicy": "huggingface-siglip2-sigmoid",
            "promptTemplate": "This is a photo of {label}.",
            "sharedService": bool(self.remote_url),
            "offline": self.offline,
            "device": "shared-service" if self.remote_url else self._device,
            "error": self._error,
        }

    def classify(self, instruction: str, sources: Iterable[str]) -> Dict[str, Any]:
        source_list = [str(source or "") for source in sources]
        if self.remote_url:
            return self._classify_remote(instruction, source_list)
        return self._classify_local(instruction, source_list)

    def _classify_local(self, instruction: str, source_list: List[str]) -> Dict[str, Any]:
        if not self._load():
            return {"selectedIndexes": [], "scores": [], "model": self.model_name, "error": self._error}

        target = self._target_text(instruction)
        loaded: List[tuple[int, Any]] = []
        scores: List[float | None] = [None] * len(source_list)
        for index, source in enumerate(source_list):
            image = self._read_image(source)
            if image is not None:
                loaded.append((index, image))

        if not loaded:
            return self._result([], scores, target, "No readable grid images")

        prompt = f"This is a photo of {target}."
        selected: List[int] = []
        try:
            with self._lock:
                inputs = self._processor(
                    text=[prompt],
                    images=[image for _, image in loaded],
                    padding="max_length",
                    max_length=64,
                    truncation=True,
                    return_tensors="pt",
                ).to(self._model.device)
                with self._torch.inference_mode():
                    outputs = self._model(**inputs)
                probabilities = self._torch.sigmoid(outputs.logits_per_image)[:, 0].detach().cpu().tolist()

            for (source_index, _), probability in zip(loaded, probabilities):
                value = float(probability)
                scores[source_index] = round(value, 6)
                if value >= self.threshold:
                    selected.append(source_index)
        except Exception as exc:
            return self._result([], scores, target, f"Vision inference failed: {exc}")

        return self._result(selected, scores, target)

    def _classify_remote(self, instruction: str, sources: List[str]) -> Dict[str, Any]:
        payload = __import__("json").dumps(
            {"instruction": str(instruction or ""), "sources": sources},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.remote_token:
            headers["Authorization"] = f"Bearer {self.remote_token}"
        request = urllib.request.Request(
            self.remote_url.rstrip("/") + "/classify",
            data=payload,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = __import__("json").loads(response.read(16 * 1024 * 1024).decode("utf-8"))
            if not isinstance(result, dict):
                raise TypeError("Vision service returned a non-object response")
            result["sharedService"] = True
            return result
        except Exception as exc:
            self._error = f"Shared vision service unavailable: {exc}"
            return {
                "selectedIndexes": [],
                "scores": [None] * len(sources),
                "model": self.model_name,
                "target": self._target_text(instruction),
                "threshold": self.threshold,
                "selectionPolicy": "huggingface-siglip2-sigmoid",
                "sharedService": True,
                "error": self._error,
            }

    def _remote_health(self) -> bool:
        headers: Dict[str, str] = {}
        if self.remote_token:
            headers["Authorization"] = f"Bearer {self.remote_token}"
        request = urllib.request.Request(self.remote_url.rstrip("/") + "/health", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                value = __import__("json").loads(response.read(64 * 1024).decode("utf-8"))
            ready = bool(isinstance(value, dict) and value.get("ready"))
            if not ready:
                self._error = str(value.get("error") or "Shared vision service is not ready") if isinstance(value, dict) else "Shared vision service is not ready"
            return ready
        except Exception as exc:
            self._error = f"Shared vision service unavailable: {exc}"
            return False

    def _result(
        self,
        selected: List[int],
        scores: List[float | None],
        target: str,
        error: str = "",
    ) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "selectedIndexes": selected,
            "scores": scores,
            "model": self.model_name,
            "target": target,
            "threshold": self.threshold,
            "selectionPolicy": "huggingface-siglip2-sigmoid",
            "promptTemplate": "This is a photo of {label}.",
            "device": self._device,
        }
        if error:
            result["error"] = error
        return result

    def _load(self) -> bool:
        if self._model is not None:
            return True
        if self._error:
            return False
        with self._lock:
            if self._model is not None:
                return True
            try:
                import torch
                from PIL import Image
                from transformers import AutoModel, AutoProcessor

                self._torch = torch
                self._image = Image
                self._device = "cuda" if torch.cuda.is_available() else "cpu"
                self._processor = AutoProcessor.from_pretrained(self.model_name, local_files_only=self.offline)
                self._model = AutoModel.from_pretrained(self.model_name, local_files_only=self.offline)
                self._model.to(self._device)
                self._model.eval()
                return True
            except Exception as exc:
                self._error = f"Vision model unavailable: {exc}"
                return False

    def _read_image(self, source: str) -> Any:
        if not source:
            return None
        try:
            if source.startswith("data:"):
                _, payload = source.split(",", 1)
                raw = base64.b64decode(payload) if ";base64" in source[: source.index(",")] else urllib.parse.unquote_to_bytes(payload)
            elif source.startswith(("http://", "https://")):
                request = urllib.request.Request(source, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(request, timeout=8) as response:
                    raw = response.read(8 * 1024 * 1024)
            else:
                return None
            return self._image.open(io.BytesIO(raw)).convert("RGB")
        except Exception:
            return None

    @staticmethod
    def _target_text(instruction: str) -> str:
        value = re.sub(r"\s+", " ", str(instruction or "")).strip()
        patterns = [
            r"(?i)^.*?(?:select|click|choose|mark)\s+(?:all\s+)?(?:images?|squares?|tiles?)\s+(?:with|containing|of)\s+",
            r"(?i)^.*?(?:wähle|wählen|klicke|anklicken|markiere|markieren)\s+(?:alle\s+)?(?:bilder|felder|kacheln)?\s*(?:mit|von|auf denen)\s+",
        ]
        for pattern in patterns:
            cleaned = re.sub(pattern, "", value).strip(" .:;-")
            if cleaned and cleaned != value:
                return cleaned[:240]
        return value[:240] or "the requested object"

    @staticmethod
    def _probability_threshold(value: str) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except ValueError:
            return DEFAULT_PROBABILITY_THRESHOLD
