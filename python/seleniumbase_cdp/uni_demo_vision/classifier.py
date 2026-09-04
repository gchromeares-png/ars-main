from __future__ import annotations

import io
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import requests
import torch
from PIL import Image
from torch import nn
from torchvision import models, transforms


@dataclass(frozen=True)
class Prediction:
    label: str
    confidence: float


class UniDemoVisionClassifier:
    """Small transfer-learning classifier for cooperative university demo pages.

    The model is intentionally independent from ARES challenge/solver code. It
    classifies image tiles into the classes present in a locally trained model.
    """

    def __init__(self, model_path: str | Path, *, device: str | None = None) -> None:
        self.model_path = Path(model_path).expanduser().resolve()
        checkpoint = torch.load(self.model_path, map_location="cpu")
        classes = checkpoint.get("classes")
        if not isinstance(classes, list) or not classes:
            raise ValueError("Vision checkpoint has no class list.")
        self.classes = [str(value) for value in classes]
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))

        model = models.mobilenet_v3_small(weights=None)
        model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(self.classes))
        model.load_state_dict(checkpoint["state_dict"])
        self.model = model.to(self.device).eval()
        self.transform = transforms.Compose(
            [
                transforms.Resize((224, 224)),
                transforms.ToTensor(),
                transforms.Normalize(
                    mean=(0.485, 0.456, 0.406),
                    std=(0.229, 0.224, 0.225),
                ),
            ]
        )

    def predict_image(self, image: Image.Image) -> Prediction:
        tensor = self.transform(image.convert("RGB")).unsqueeze(0).to(self.device)
        with torch.inference_mode():
            probabilities = torch.softmax(self.model(tensor), dim=1)[0]
        index = int(torch.argmax(probabilities).item())
        return Prediction(self.classes[index], float(probabilities[index].item()))

    def predict_sources(self, sources: Iterable[str]) -> List[Prediction]:
        return [self.predict_image(self._load_image(source)) for source in sources]

    @staticmethod
    def load_aliases(path: str | Path | None) -> Dict[str, str]:
        if not path:
            return {}
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("Alias file must be a JSON object.")
        return {str(key).strip().lower(): str(value).strip().lower() for key, value in raw.items()}

    @classmethod
    def normalize_target(cls, value: str, aliases: Dict[str, str]) -> str:
        normalized = " ".join(value.strip().lower().replace("_", " ").split())
        return aliases.get(normalized, normalized)

    @staticmethod
    def selected_indexes(
        predictions: Iterable[Prediction],
        *,
        target: str,
        threshold: float,
    ) -> List[int]:
        normalized_target = target.strip().lower()
        return [
            index
            for index, prediction in enumerate(predictions)
            if prediction.label.strip().lower() == normalized_target
            and prediction.confidence >= threshold
        ]

    @staticmethod
    def _load_image(source: str) -> Image.Image:
        source = source.strip()
        if source.startswith("data:image/"):
            header, payload = source.split(",", 1)
            if ";base64" not in header:
                raise ValueError("Only base64 image data URLs are supported.")
            import base64

            return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")
        if source.startswith("http://") or source.startswith("https://"):
            response = requests.get(source, timeout=12)
            response.raise_for_status()
            return Image.open(io.BytesIO(response.content)).convert("RGB")
        return Image.open(Path(source).expanduser()).convert("RGB")
