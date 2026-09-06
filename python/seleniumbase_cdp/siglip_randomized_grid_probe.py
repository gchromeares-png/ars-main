from __future__ import annotations

import base64
import io
import math
import os
import random
from typing import Any, Dict, List, Tuple

from PIL import Image, ImageDraw

from robust_vision_grid_classifier import RobustVisionGridClassifier


CATEGORIES: Tuple[str, ...] = (
    "crosswalk",
    "traffic light",
    "bicycle",
    "car",
)


def _seed() -> int:
    configured = str(os.environ.get("ARES_SIGLIP_TEST_SEED") or "").strip()
    if configured:
        return int(configured, 0)
    return int.from_bytes(os.urandom(8), "big")


def _scene_base(rng: random.Random, variant: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (224, 224), (176, 205, 226))
    draw = ImageDraw.Draw(image)

    # Sky / horizon / road. Slightly vary every tile so no category is represented
    # by byte-identical images and SigLIP2 has to use the visible object itself.
    horizon = 70 + ((variant * 7) % 15)
    draw.rectangle((0, horizon, 224, 224), fill=(92, 97, 101))
    draw.rectangle((0, horizon - 12, 224, horizon), fill=(94, 143, 79))

    # Road perspective and lane markings.
    draw.polygon(((32, 224), (88, horizon), (136, horizon), (196, 224)), fill=(68, 71, 74))
    lane_shift = (-6, 0, 5)[variant % 3]
    draw.polygon(((109 + lane_shift, 224), (111, horizon + 8), (114, horizon + 8), (117 + lane_shift, 224)), fill=(226, 216, 132))

    # Add harmless visual clutter so simple colour matching is insufficient.
    for _ in range(5):
        x = rng.randint(4, 210)
        y = rng.randint(8, max(12, horizon - 18))
        radius = rng.randint(2, 5)
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(245, 245, 240))
    return image, draw


def _draw_crosswalk(draw: ImageDraw.ImageDraw, variant: int) -> None:
    y0 = 128 + (-5, 0, 5)[variant % 3]
    for stripe in range(6):
        y = y0 + stripe * 11
        left = 48 + stripe * 4
        right = 176 - stripe * 4
        draw.polygon(((left, y), (right, y), (right - 3, y + 7), (left + 3, y + 7)), fill=(239, 239, 232))


def _draw_traffic_light(draw: ImageDraw.ImageDraw, variant: int) -> None:
    x = 54 + (-8, 2, 9)[variant % 3]
    draw.rectangle((x + 17, 75, x + 22, 174), fill=(48, 49, 49))
    draw.rounded_rectangle((x, 58, x + 40, 116), radius=7, fill=(34, 36, 36), outline=(10, 10, 10), width=2)
    for index, colour in enumerate(((208, 45, 43), (229, 181, 51), (48, 167, 86))):
        cy = 70 + index * 18
        draw.ellipse((x + 12, cy - 6, x + 28, cy + 10), fill=colour, outline=(12, 12, 12))


def _draw_bicycle(draw: ImageDraw.ImageDraw, variant: int) -> None:
    shift = (-8, 1, 8)[variant % 3]
    y = 154
    left_x, right_x = 76 + shift, 146 + shift
    radius = 25
    for x in (left_x, right_x):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=(24, 24, 24), width=5)
    crank = (111 + shift, 151)
    draw.line((left_x, y, crank[0], crank[1], right_x, y), fill=(36, 49, 58), width=5)
    draw.line((crank[0], crank[1], 98 + shift, 122, 126 + shift, 122, right_x, y), fill=(36, 49, 58), width=5)
    draw.line((98 + shift, 122, 92 + shift, 111), fill=(24, 24, 24), width=4)
    draw.line((126 + shift, 122, 135 + shift, 108), fill=(24, 24, 24), width=4)


def _draw_car(draw: ImageDraw.ImageDraw, variant: int) -> None:
    shift = (-8, 0, 7)[variant % 3]
    body = (55 + shift, 125, 171 + shift, 170)
    draw.rounded_rectangle(body, radius=12, fill=(45, 93, 168), outline=(20, 30, 42), width=3)
    draw.polygon(((76 + shift, 126), (95 + shift, 101), (137 + shift, 101), (155 + shift, 126)), fill=(70, 115, 175), outline=(20, 30, 42))
    draw.polygon(((94 + shift, 105), (104 + shift, 105), (104 + shift, 124), (81 + shift, 124)), fill=(171, 208, 224))
    draw.polygon(((109 + shift, 105), (134 + shift, 105), (149 + shift, 124), (109 + shift, 124)), fill=(171, 208, 224))
    for x in (80 + shift, 148 + shift):
        draw.ellipse((x - 14, 157, x + 14, 185), fill=(22, 22, 22))
        draw.ellipse((x - 6, 165, x + 6, 177), fill=(122, 126, 129))


def _tile_png(category: str, variant: int, seed: int) -> str:
    rng = random.Random((seed << 8) ^ (variant * 7919) ^ sum(ord(ch) for ch in category))
    image, draw = _scene_base(rng, variant)

    if category == "crosswalk":
        _draw_crosswalk(draw, variant)
    elif category == "traffic light":
        _draw_traffic_light(draw, variant)
    elif category == "bicycle":
        _draw_bicycle(draw, variant)
    elif category == "car":
        _draw_car(draw, variant)
    else:
        raise ValueError(f"Unsupported test category: {category}")

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    payload = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{payload}"


def _embedding_scores(classifier: RobustVisionGridClassifier, target: str, sources: List[str]) -> Dict[str, Any]:
    if not classifier._load():
        return {"scores": [], "error": classifier.error}

    loaded: List[Tuple[int, Any]] = []
    for index, source in enumerate(sources):
        image = classifier._read_image(source)
        if image is not None:
            loaded.append((index, image))
    if not loaded:
        return {"scores": [], "error": "No readable images for embedding path"}

    processor = classifier._processor
    model = classifier._model
    torch = classifier._torch
    device = classifier._device
    prompt = f"This is a photo of {target}."

    try:
        image_inputs = processor(images=[image for _, image in loaded], return_tensors="pt")
        text_inputs = processor(text=[prompt], padding="max_length", max_length=64, truncation=True, return_tensors="pt")
        image_inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in image_inputs.items()}
        text_inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in text_inputs.items()}

        image_kwargs = {key: value for key, value in image_inputs.items() if key in {"pixel_values", "pixel_attention_mask", "spatial_shapes"}}
        text_kwargs = {key: value for key, value in text_inputs.items() if key in {"input_ids", "attention_mask"}}
        with torch.inference_mode():
            image_features = model.get_image_features(**image_kwargs).float()
            text_features = model.get_text_features(**text_kwargs).float()
        image_features = torch.nn.functional.normalize(image_features, p=2, dim=-1)
        text_features = torch.nn.functional.normalize(text_features, p=2, dim=-1)
        similarities = (image_features @ text_features.T)[:, 0].detach().cpu().tolist()
    except Exception as exc:
        return {"scores": [], "error": f"Embedding inference failed: {exc}"}

    scores: List[float | None] = [None] * len(sources)
    for (source_index, _), similarity in zip(loaded, similarities):
        scores[source_index] = round(float(similarity), 6)
    return {"scores": scores, "error": ""}


def _separation(scores: List[float | None], expected: List[int]) -> Dict[str, float]:
    expected_set = set(expected)
    target_scores = [float(scores[index]) for index in expected if index < len(scores) and scores[index] is not None]
    distractor_scores = [float(value) for index, value in enumerate(scores) if index not in expected_set and value is not None]
    if len(target_scores) != len(expected) or not distractor_scores:
        raise AssertionError(f"Incomplete score vector: expected={expected}, scores={scores}")
    return {
        "minTarget": min(target_scores),
        "maxDistractor": max(distractor_scores),
        "margin": min(target_scores) - max(distractor_scores),
    }


def _round(rng: random.Random, round_index: int, seed: int) -> Dict[str, Any]:
    tiles: List[Dict[str, Any]] = []
    for category_index, label in enumerate(CATEGORIES):
        for variant in range(3):
            tiles.append({
                "category": category_index,
                "source": _tile_png(label, variant, seed ^ (round_index * 104729)),
            })

    rng.shuffle(tiles)
    target_category = rng.randrange(len(CATEGORIES))
    target_label = CATEGORIES[target_category]
    expected = sorted(index for index, tile in enumerate(tiles) if tile["category"] == target_category)
    sources = [str(tile["source"]) for tile in tiles]

    classifier = RobustVisionGridClassifier()

    # A: current production path: full SigLIP2 forward + logits_per_image + sigmoid.
    logits_result = classifier.classify(f"Select all images with {target_label}", sources)
    if logits_result.get("error"):
        raise AssertionError(f"SigLIP2 logits path failed in round {round_index}: {logits_result.get('error')}")
    logits_scores = logits_result.get("scores") or []
    logits_sep = _separation(logits_scores, expected)
    logits_selected = sorted(int(value) for value in logits_result.get("selectedIndexes") or [])

    # B: official feature APIs: image/text embeddings, L2-normalized, cosine similarity.
    embedding_result = _embedding_scores(classifier, target_label, sources)
    if embedding_result.get("error"):
        raise AssertionError(f"SigLIP2 embedding path failed in round {round_index}: {embedding_result.get('error')}")
    embedding_scores = embedding_result.get("scores") or []
    embedding_sep = _separation(embedding_scores, expected)

    # Both paths must at minimum rank every true target above every distractor.
    # The current production path is additionally required to satisfy its actual
    # runtime threshold and return exactly the ground-truth indexes.
    if logits_sep["margin"] <= 0 or logits_selected != expected:
        raise AssertionError(
            "SigLIP2 logits path failed randomized street-grid ground truth: "
            f"round={round_index}, target={target_label!r}, expected={expected}, selected={logits_selected}, "
            f"margin={logits_sep['margin']:.6f}, scores={logits_scores}"
        )
    if embedding_sep["margin"] <= 0:
        raise AssertionError(
            "SigLIP2 embedding path failed randomized street-grid ranking: "
            f"round={round_index}, target={target_label!r}, expected={expected}, "
            f"margin={embedding_sep['margin']:.6f}, scores={embedding_scores}"
        )

    return {
        "target": target_label,
        "expected": expected,
        "logitsSelected": logits_selected,
        "logitsMargin": logits_sep["margin"],
        "embeddingMargin": embedding_sep["margin"],
        "winner": "embedding" if embedding_sep["margin"] > logits_sep["margin"] else "logits",
        "device": logits_result.get("device"),
        "model": logits_result.get("model"),
    }


def main() -> int:
    seed = _seed()
    rounds = max(1, int(os.environ.get("ARES_SIGLIP_TEST_ROUNDS", "3")))
    rng = random.Random(seed)
    print(f"SIGLIP_RANDOM_SEED={seed}")

    results = [_round(rng, index + 1, seed) for index in range(rounds)]
    embedding_wins = 0
    logits_wins = 0
    for index, result in enumerate(results, start=1):
        if result["winner"] == "embedding":
            embedding_wins += 1
        else:
            logits_wins += 1
        print(
            "SIGLIP_AB_ROUND "
            f"{index}/{rounds} target={result['target']!r} expected={result['expected']} "
            f"logitsSelected={result['logitsSelected']} logitsMargin={result['logitsMargin']:.6f} "
            f"embeddingMargin={result['embeddingMargin']:.6f} winner={result['winner']} "
            f"device={result['device']}"
        )

    print(
        "SIGLIP_AB_SUMMARY "
        f"rounds={rounds} logitsWins={logits_wins} embeddingWins={embedding_wins}"
    )
    print(
        "PASS: randomized street-scene SigLIP2 A/B probe separated crosswalk/traffic-light/"
        "bicycle/car targets from pixels only, with runtime-shuffled positions and no rendered hints."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
