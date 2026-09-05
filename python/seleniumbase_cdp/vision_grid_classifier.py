from __future__ import annotations

import io
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List

import requests
import torch
from PIL import Image
from torch import nn
from torchvision import models, transforms


@dataclass(frozen=True)
class Prediction:
    label: str
    confidence: float


class VisionGridClassifier:
    def __init__(self, model_path: str | Path, *, device: str | None = None) -> None:
        checkpoint = torch.load(Path(model_path).expanduser().resolve(), map_location="cpu")
        self.classes = [str(value) for value in checkpoint.get("classes") or []]
        if not self.classes:
            raise ValueError("Vision checkpoint has no classes")
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        model = models.mobilenet_v3_small(weights=None)
        model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(self.classes))
        model.load_state_dict(checkpoint["state_dict"])
        self.model = model.to(self.device).eval()
        self.transform = transforms.Compose([
            transforms.Resize((224, 224)),
            transforms.ToTensor(),
            transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
        ])

    def predict_sources(self, sources: Iterable[str]) -> List[Prediction]:
        return [self.predict_image(self._load_image(source)) for source in sources]

    def predict_image(self, image: Image.Image) -> Prediction:
        tensor = self.transform(image.convert("RGB")).unsqueeze(0).to(self.device)
        with torch.inference_mode():
            probabilities = torch.softmax(self.model(tensor), dim=1)[0]
        index = int(torch.argmax(probabilities).item())
        return Prediction(self.classes[index], float(probabilities[index].item()))

    def target_from_instruction(self, instruction: str, aliases: Dict[str, str] | None = None) -> str:
        text = self._normalize(instruction)
        aliases = aliases or {}
        for phrase, label in sorted(aliases.items(), key=lambda item: len(item[0]), reverse=True):
            if self._normalize(phrase) in text:
                return self._normalize(label)
        for label in sorted(self.classes, key=len, reverse=True):
            normalized = self._normalize(label)
            variants = {normalized, normalized.rstrip("s"), normalized + "s"}
            if any(value and value in text for value in variants):
                return normalized
        return ""

    @staticmethod
    def selected_indexes(predictions: Iterable[Prediction], target: str, threshold: float) -> List[int]:
        target = VisionGridClassifier._normalize(target)
        return [
            index for index, prediction in enumerate(predictions)
            if VisionGridClassifier._normalize(prediction.label) == target and prediction.confidence >= threshold
        ]

    @staticmethod
    def load_aliases(path: str | Path | None) -> Dict[str, str]:
        if not path:
            return {}
        raw = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
        return {str(key): str(value) for key, value in raw.items()} if isinstance(raw, dict) else {}

    @staticmethod
    def _normalize(value: str) -> str:
        return " ".join(str(value).lower().replace("_", " ").replace("-", " ").split())

    @staticmethod
    def _load_image(source: str) -> Image.Image:
        source = source.strip()
        if source.startswith("data:image/"):
            import base64
            header, payload = source.split(",", 1)
            if ";base64" not in header:
                raise ValueError("Only base64 data images are supported")
            return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")
        if source.startswith("http://") or source.startswith("https://"):
            response = requests.get(source, timeout=12)
            response.raise_for_status()
            return Image.open(io.BytesIO(response.content)).convert("RGB")
        return Image.open(Path(source).expanduser()).convert("RGB")
