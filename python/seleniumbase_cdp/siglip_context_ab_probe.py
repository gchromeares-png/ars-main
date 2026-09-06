from __future__ import annotations

import base64
import io
import os
import random
import statistics
import time
from typing import Any, Dict, List

from PIL import Image

from robust_vision_grid_classifier import RobustVisionGridClassifier
from siglip_randomized_grid_probe import CATEGORIES, _make_grid, _seed, _separation


def _decode(source: str) -> Image.Image:
    payload = source.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


def _data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _whole_grid_source(sources: List[str], columns: int = 4) -> str:
    images = [_decode(source) for source in sources]
    if not images:
        raise AssertionError("No tiles for whole-grid context")
    tile_w, tile_h = images[0].size
    rows = (len(images) + columns - 1) // columns
    grid = Image.new("RGB", (tile_w * columns, tile_h * rows), (24, 24, 24))
    for index, image in enumerate(images):
        x = (index % columns) * tile_w
        y = (index // columns) * tile_h
        grid.paste(image, (x, y))
    return _data_url(grid)


def _selected(scores: List[float | None], threshold: float) -> List[int]:
    return [index for index, score in enumerate(scores) if score is not None and float(score) >= threshold]


def _mean(values: List[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def main() -> int:
    seed = _seed()
    rounds = max(1, min(8, int(os.environ.get("ARES_SIGLIP_AB_ROUNDS", "2"))))
    rng = random.Random(seed)
    print(f"SIGLIP_AB_SEED={seed} rounds={rounds}")

    classifier = RobustVisionGridClassifier()
    load_started = time.perf_counter()
    if not classifier._load():
        raise AssertionError(f"SigLIP2 unavailable: {classifier.error}")
    warmup_ms = (time.perf_counter() - load_started) * 1000.0
    print(
        f"SIGLIP_AB_PREFLIGHT model={classifier.model_name} device={classifier._device} "
        f"threshold={classifier.threshold} warmupMs={warmup_ms:.2f}"
    )

    tile_only_ms: List[float] = []
    context_batch_ms: List[float] = []
    tile_exact = 0
    context_exact = 0
    comparisons = 0
    failures: List[str] = []
    context_scores: List[float] = []

    for round_index in range(rounds):
        tiles, sources = _make_grid(rng, seed ^ ((round_index + 1) * 104729))
        whole_source = _whole_grid_source(sources)

        for category_index, target in enumerate(CATEGORIES):
            expected = sorted(index for index, tile in enumerate(tiles) if tile["category"] == category_index)
            instruction = f"Select all images with {target}"

            started = time.perf_counter()
            tile_result = classifier.classify(instruction, sources)
            elapsed_tile = (time.perf_counter() - started) * 1000.0
            tile_only_ms.append(elapsed_tile)
            if tile_result.get("error"):
                failures.append(f"round={round_index} target={target}: tile-only error={tile_result.get('error')}")
                continue

            started = time.perf_counter()
            context_result = classifier.classify(instruction, [whole_source, *sources])
            elapsed_context = (time.perf_counter() - started) * 1000.0
            context_batch_ms.append(elapsed_context)
            if context_result.get("error"):
                failures.append(f"round={round_index} target={target}: context-batch error={context_result.get('error')}")
                continue

            tile_scores = list(tile_result.get("scores") or [])
            combined_scores = list(context_result.get("scores") or [])
            if len(tile_scores) != len(sources) or len(combined_scores) != len(sources) + 1:
                failures.append(
                    f"round={round_index} target={target}: score vector sizes "
                    f"tile={len(tile_scores)} combined={len(combined_scores)}"
                )
                continue

            context_score = combined_scores[0]
            context_scores.append(float(context_score) if context_score is not None else 0.0)
            context_tile_scores = combined_scores[1:]
            tile_selection = _selected(tile_scores, classifier.threshold)
            context_selection = _selected(context_tile_scores, classifier.threshold)
            tile_sep = _separation(tile_scores, expected)
            context_sep = _separation(context_tile_scores, expected)

            comparisons += 1
            tile_exact += int(tile_selection == expected)
            context_exact += int(context_selection == expected)
            if tile_sep["margin"] <= 0:
                failures.append(
                    f"round={round_index} target={target}: tile-only ranking margin {tile_sep['margin']:.6f} <= 0"
                )
            if context_sep["margin"] <= 0:
                failures.append(
                    f"round={round_index} target={target}: context-batch ranking margin {context_sep['margin']:.6f} <= 0"
                )

            print(
                "SIGLIP_AB_CASE "
                f"round={round_index} target={target!r} expected={expected} "
                f"tileSelected={tile_selection} contextSelected={context_selection} "
                f"contextScore={float(context_score or 0.0):.6f} "
                f"tileMargin={tile_sep['margin']:.6f} contextMargin={context_sep['margin']:.6f} "
                f"tileMs={elapsed_tile:.2f} contextBatchMs={elapsed_context:.2f}"
            )

    if comparisons <= 0:
        raise AssertionError("SigLIP A/B produced no comparable cases")

    print(
        "SIGLIP_AB_SUMMARY "
        f"cases={comparisons} tileExact={tile_exact}/{comparisons} contextExact={context_exact}/{comparisons} "
        f"tileMeanMs={_mean(tile_only_ms):.2f} contextBatchMeanMs={_mean(context_batch_ms):.2f} "
        f"contextOverheadMs={_mean(context_batch_ms) - _mean(tile_only_ms):.2f} "
        f"meanContextScore={_mean(context_scores):.6f}"
    )

    if failures:
        raise AssertionError("SigLIP A/B ranking/runtime failures:\n- " + "\n- ".join(failures))

    print(
        "PASS: tile-only and whole-grid-context + tile-batch were measured on identical randomized grids. "
        "No production threshold or selection policy was changed."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
