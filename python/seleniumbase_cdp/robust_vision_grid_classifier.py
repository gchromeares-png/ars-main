from __future__ import annotations

import re
from typing import Any

from vision_grid_classifier import VisionGridClassifier


class RobustVisionGridClassifier(VisionGridClassifier):
    """Small robustness layer over the existing SigLIP2 classifier."""

    def _read_image(self, source: str) -> Any:
        image = super()._read_image(source)
        if image is None:
            return None
        try:
            width, height = image.size
            shortest = min(int(width), int(height))
            if 0 < shortest < 112:
                scale = min(4.0, 224.0 / shortest)
                target = (
                    max(1, int(round(width * scale))),
                    max(1, int(round(height * scale))),
                )
                resampling = getattr(getattr(self._image, "Resampling", None), "LANCZOS", None)
                if resampling is None:
                    resampling = getattr(self._image, "LANCZOS", 1)
                image = image.resize(target, resample=resampling)
        except Exception:
            pass
        return image

    @staticmethod
    def _target_text(instruction: str) -> str:
        value = re.sub(r"\s+", " ", str(instruction or "")).strip()
        if not value:
            return "the requested object"

        patterns = (
            r"(?i)^.*?\b(?:click|select|choose|mark)\b\s+(?:all\s+)?(?:the\s+)?(?:images?|squares?|tiles?)?\s*(?:with|containing|showing|of)?\s*",
            r"(?i)^.*?\b(?:click|select|choose|mark)\b\s+(?:all\s+)?(?:the\s+)?",
            r"(?i)^.*?\b(?:klicke|anklicken|wähle|wählen|markiere|markieren)\b\s+(?:alle\s+)?(?:bilder|felder|kacheln)?\s*(?:mit|von|auf denen|auf)?\s*",
        )
        cleaned = value
        for pattern in patterns:
            candidate = re.sub(pattern, "", value).strip(" .:;-")
            if candidate and candidate != value:
                cleaned = candidate
                break

        cleaned = re.sub(
            r"(?i)\b(?:and then|then|danach|anschließend)\b.*$",
            "",
            cleaned,
        ).strip(" .:;-")
        return cleaned[:240] or value[:240]
