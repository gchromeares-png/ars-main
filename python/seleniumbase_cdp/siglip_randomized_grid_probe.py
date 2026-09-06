from __future__ import annotations

import base64
import io
import os
import random
from typing import Any, Dict, List, Tuple

from PIL import Image, ImageDraw, ImageFont

from robust_vision_grid_classifier import RobustVisionGridClassifier


CATEGORIES: Tuple[Tuple[str, str, str], ...] = (
    ("red circle", "circle", "red"),
    ("blue square", "square", "blue"),
    ("green triangle", "triangle", "green"),
    ("orange star", "star", "orange"),
)


def _seed() -> int:
    configured = str(os.environ.get("ARES_SIGLIP_TEST_SEED") or "").strip()
    if configured:
        return int(configured, 0)
    return int.from_bytes(os.urandom(8), "big")


def _font(size: int) -> ImageFont.ImageFont:
    candidates = (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/arial.ttf",
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _star_points(cx: float, cy: float, outer: float, inner: float) -> List[Tuple[float, float]]:
    import math

    points: List[Tuple[float, float]] = []
    for index in range(10):
        radius = outer if index % 2 == 0 else inner
        angle = -math.pi / 2 + index * math.pi / 5
        points.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    return points


def _tile_png(label: str, shape: str, colour: str, variant: int) -> str:
    image = Image.new("RGB", (224, 224), "white")
    draw = ImageDraw.Draw(image)

    # Small per-tile jitter prevents the probe from being a set of byte-identical
    # duplicates while keeping the semantic object unambiguous.
    jitter_x = (-7, 0, 7)[variant % 3]
    jitter_y = (5, -5, 0)[variant % 3]
    cx, cy = 112 + jitter_x, 90 + jitter_y
    radius = 55

    if shape == "circle":
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=colour, outline="black", width=4)
    elif shape == "square":
        draw.rounded_rectangle((cx - radius, cy - radius, cx + radius, cy + radius), radius=8, fill=colour, outline="black", width=4)
    elif shape == "triangle":
        draw.polygon(((cx, cy - 62), (cx - 62, cy + 50), (cx + 62, cy + 50)), fill=colour, outline="black")
    elif shape == "star":
        draw.polygon(_star_points(cx, cy, 64, 28), fill=colour, outline="black")
    else:
        raise ValueError(f"Unsupported test shape: {shape}")

    # The caption intentionally describes the visible object instead of encoding
    # an index. SigLIP2 still has to match image/text semantics after the runtime
    # shuffle; no answer positions are embedded in the prompt or source order.
    font = _font(24)
    text_box = draw.textbbox((0, 0), label, font=font)
    text_width = text_box[2] - text_box[0]
    draw.text(((224 - text_width) / 2, 174), label, fill="black", font=font)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    payload = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{payload}"


def _round(rng: random.Random, round_index: int) -> Dict[str, Any]:
    tiles: List[Dict[str, Any]] = []
    for category_index, (label, shape, colour) in enumerate(CATEGORIES):
        for variant in range(3):
            tiles.append(
                {
                    "category": category_index,
                    "label": label,
                    "source": _tile_png(label, shape, colour, variant),
                }
            )

    rng.shuffle(tiles)
    target_category = rng.randrange(len(CATEGORIES))
    target_label = CATEGORIES[target_category][0]
    expected = [index for index, tile in enumerate(tiles) if tile["category"] == target_category]

    classifier = RobustVisionGridClassifier()
    result = classifier.classify(
        f"Select all images with {target_label}",
        [str(tile["source"]) for tile in tiles],
    )
    if result.get("error"):
        raise AssertionError(
            f"SigLIP2 unavailable or inference failed in randomized round {round_index}: "
            f"{result.get('error')}"
        )

    scores = result.get("scores") or []
    selected = sorted(int(value) for value in result.get("selectedIndexes") or [])
    expected_sorted = sorted(expected)

    target_scores = [float(scores[index]) for index in expected_sorted if scores[index] is not None]
    distractor_scores = [
        float(score)
        for index, score in enumerate(scores)
        if index not in expected_sorted and score is not None
    ]
    if len(target_scores) != len(expected_sorted) or not distractor_scores:
        raise AssertionError(f"Incomplete SigLIP2 score vector in round {round_index}: {result}")

    ranking_ok = min(target_scores) > max(distractor_scores)
    selection_ok = selected == expected_sorted
    if not ranking_ok or not selection_ok:
        raise AssertionError(
            "Randomized SigLIP2 grid classification failed: "
            f"round={round_index}, target={target_label!r}, expected={expected_sorted}, "
            f"selected={selected}, minTarget={min(target_scores):.4f}, "
            f"maxDistractor={max(distractor_scores):.4f}, threshold={result.get('threshold')}, "
            f"scores={scores}"
        )

    return {
        "target": target_label,
        "expected": expected_sorted,
        "selected": selected,
        "minTarget": round(min(target_scores), 4),
        "maxDistractor": round(max(distractor_scores), 4),
        "device": result.get("device"),
        "model": result.get("model"),
    }


def main() -> int:
    seed = _seed()
    rounds = max(1, int(os.environ.get("ARES_SIGLIP_TEST_ROUNDS", "3")))
    rng = random.Random(seed)
    print(f"SIGLIP_RANDOM_SEED={seed}")

    results = [_round(rng, index + 1) for index in range(rounds)]
    for index, result in enumerate(results, start=1):
        print(
            "SIGLIP_RANDOM_ROUND "
            f"{index}/{rounds} target={result['target']!r} expected={result['expected']} "
            f"selected={result['selected']} minTarget={result['minTarget']:.4f} "
            f"maxDistractor={result['maxDistractor']:.4f} device={result['device']}"
        )

    print(
        "PASS: randomized SigLIP2 grid probe classified every runtime-shuffled target "
        "without precomputed answer positions."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
