from __future__ import annotations

import base64
import io
import os
import re
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List


class VisionGridClassifier:
    """Lazy zero-shot image/text classifier for structural test grids."""

    def __init__(self) -> None:
        self.model_name = os.environ.get("ARES_VISION_MODEL", "google/siglip2-base-patch16-224").strip()
        self.threshold = self._threshold(os.environ.get("ARES_VISION_THRESHOLD", "0.58"))
        self.offline = os.environ.get("ARES_VISION_OFFLINE", "0").strip() == "1"
        self._processor: Any = None
        self._model: Any = None
        self._torch: Any = None
        self._image: Any = None
        self._error = ""

    @property
    def ready(self) -> bool:
        return self._load()

    @property
    def error(self) -> str:
        return self._error

    def status(self) -> Dict[str, Any]:
        ready = self._load()
        return {"ready": ready, "model": self.model_name, "threshold": self.threshold, "offline": self.offline, "error": self._error}

    def classify(self, instruction: str, sources: Iterable[str]) -> Dict[str, Any]:
        if not self._load():
            return {"selectedIndexes": [], "scores": [], "model": self.model_name, "error": self._error}

        target = self._target_text(instruction)
        positives = [f"an image matching this request: {target}", f"a photo of {target}"]
        negatives = ["an image that does not match the requested object", "an unrelated image"]
        selected: List[int] = []
        scores: List[float | None] = []

        for index, source in enumerate(sources):
            image = self._read_image(str(source or ""))
            if image is None:
                scores.append(None)
                continue
            try:
                inputs = self._processor(
                    text=positives + negatives,
                    images=image,
                    padding="max_length",
                    return_tensors="pt",
                )
                with self._torch.no_grad():
                    outputs = self._model(**inputs)
                logits = outputs.logits_per_image[0].float()
                positive = self._torch.logsumexp(logits[: len(positives)], dim=0)
                negative = self._torch.logsumexp(logits[len(positives) :], dim=0)
                score = float(self._torch.sigmoid(positive - negative).item())
            except Exception:
                scores.append(None)
                continue
            scores.append(round(score, 4))
            if score >= self.threshold:
                selected.append(index)

        return {
            "selectedIndexes": selected,
            "scores": scores,
            "model": self.model_name,
            "target": target,
            "threshold": self.threshold,
        }

    def _load(self) -> bool:
        if self._model is not None:
            return True
        if self._error:
            return False
        try:
            import torch
            from PIL import Image
            from transformers import AutoModel, AutoProcessor

            self._torch = torch
            self._image = Image
            self._processor = AutoProcessor.from_pretrained(self.model_name, local_files_only=self.offline)
            self._model = AutoModel.from_pretrained(self.model_name, local_files_only=self.offline)
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
    def _threshold(value: str) -> float:
        try:
            return max(0.05, min(0.95, float(value)))
        except ValueError:
            return 0.58
