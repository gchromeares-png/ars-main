from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Dict, Iterable, List


def build_stable_marks(
    values: Iterable[Dict[str, Any]],
    *,
    scope: str,
    viewport: Dict[str, Any] | None = None,
    observed_at: float | None = None,
) -> List[Dict[str, Any]]:
    """Build coordinate-independent mark identities for one browser observation."""
    timestamp = float(observed_at if observed_at is not None else time.time())
    viewport_data = _viewport(viewport or {})
    result: List[Dict[str, Any]] = []
    for index, raw in enumerate(values):
        if not isinstance(raw, dict):
            continue
        role = str(raw.get("role") or "element").strip() or "element"
        structural_key = str(raw.get("structuralKey") or raw.get("selector") or f"slot:{index}").strip()
        semantic_input = str(raw.get("semanticSignature") or raw.get("label") or raw.get("source") or role).strip()
        identity_seed = "|".join((str(scope), role, structural_key))
        signature_seed = "|".join((role, semantic_input))
        stable_id = f"{_prefix(role)}-{hashlib.sha256(identity_seed.encode('utf-8', errors='ignore')).hexdigest()[:12]}"
        semantic_visual_signature = hashlib.sha256(signature_seed.encode("utf-8", errors="ignore")).hexdigest()
        confidence = _clamp(raw.get("confidence"), default=0.5)
        bounds = _bounds(raw.get("visualBounds") or raw.get("rect"))
        mark = {
            "markId": stable_id,
            "role": role,
            "visualBounds": bounds,
            "confidence": confidence,
            "frameViewport": {
                "scope": str(scope),
                "viewport": viewport_data,
            },
            "observedAt": timestamp,
            "semanticVisualSignature": semantic_visual_signature,
            "structuralKey": structural_key,
        }
        for key in ("label", "selector", "source", "fraction", "score"):
            if key in raw and raw.get(key) is not None:
                mark[key] = raw.get(key)
        result.append(mark)
    return result


def mark_signature(mark: Dict[str, Any]) -> str:
    return str(mark.get("semanticVisualSignature") or "")


def _prefix(role: str) -> str:
    normalized = "".join(ch for ch in role.upper() if ch.isalnum())[:3]
    return normalized or "MRK"


def _viewport(value: Dict[str, Any]) -> Dict[str, float]:
    defaults = {"width": 0.0, "height": 0.0, "scrollX": 0.0, "scrollY": 0.0, "devicePixelRatio": 1.0}
    result: Dict[str, float] = {}
    for key, default in defaults.items():
        try:
            result[key] = float(value.get(key, default))
        except (TypeError, ValueError):
            result[key] = default
    return result


def _bounds(value: Any) -> Dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    result: Dict[str, float] = {}
    for key in ("x", "y", "width", "height"):
        try:
            result[key] = float(value.get(key) or 0.0)
        except (TypeError, ValueError):
            result[key] = 0.0
    return result


def _clamp(value: Any, *, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return round(max(0.0, min(1.0, number)), 4)


def stable_mark_digest(values: Iterable[Dict[str, Any]]) -> str:
    compact = [
        {
            "markId": str(item.get("markId") or ""),
            "semanticVisualSignature": str(item.get("semanticVisualSignature") or ""),
        }
        for item in values
        if isinstance(item, dict)
    ]
    return hashlib.sha256(json.dumps(compact, sort_keys=True).encode("utf-8")).hexdigest()
