from __future__ import annotations

import math
import random
import time

from siglip_randomized_grid_probe import CATEGORIES, _make_grid, _seed
from vision_grid_classifier import VisionGridClassifier


def main() -> int:
    seed = _seed()
    rng = random.Random(seed ^ 0x5EEDBEEF)
    _tiles, sources = _make_grid(rng, seed)
    target = CATEGORIES[0]
    instruction = f"Select all images with {target}"

    classifier = VisionGridClassifier(allow_remote=False)
    started = time.perf_counter()
    if not classifier._load():
        raise AssertionError(f"SigLIP2 unavailable: {classifier.error}")
    load_ms = (time.perf_counter() - started) * 1000.0

    production = classifier.classify(instruction, sources)
    if production.get("error"):
        raise AssertionError(f"Production SigLIP2 inference failed: {production['error']}")

    images = [classifier._read_image(source) for source in sources]
    if any(image is None for image in images):
        raise AssertionError("Reference parity probe could not decode every grid tile")

    label = classifier._target_text(instruction)
    prompt = f"This is a photo of {label}."
    inputs = classifier._processor(
        text=[prompt],
        images=images,
        padding="max_length",
        max_length=64,
        truncation=True,
        return_tensors="pt",
    ).to(classifier._model.device)

    with classifier._torch.inference_mode():
        outputs = classifier._model(**inputs)
    reference_scores = classifier._torch.sigmoid(outputs.logits_per_image)[:, 0].detach().cpu().tolist()

    production_scores = production.get("scores") or []
    if len(production_scores) != len(reference_scores):
        raise AssertionError(
            f"Score count mismatch: production={len(production_scores)} reference={len(reference_scores)}"
        )

    diffs = [
        abs(float(actual) - float(expected))
        for actual, expected in zip(production_scores, reference_scores)
        if actual is not None
    ]
    max_abs_diff = max(diffs) if diffs else math.inf
    reference_selected = [
        index for index, score in enumerate(reference_scores)
        if float(score) >= classifier.threshold
    ]
    production_selected = [int(value) for value in production.get("selectedIndexes") or []]

    print(
        "SIGLIP2_REFERENCE_PARITY "
        f"seed={seed} model={classifier.model_name} processor={type(classifier._processor).__name__} "
        f"device={classifier._device} loadMs={load_ms:.2f} maxAbsDiff={max_abs_diff:.8f} "
        f"selectionMatch={production_selected == reference_selected}"
    )

    if max_abs_diff > 1e-5:
        raise AssertionError(f"Production scores diverge from Hugging Face reference path: {max_abs_diff:.8f}")
    if production_selected != reference_selected:
        raise AssertionError(
            f"Production selection diverges from Hugging Face reference path: "
            f"production={production_selected} reference={reference_selected}"
        )
    if production.get("selectionPolicy") != "huggingface-siglip2-sigmoid":
        raise AssertionError(f"Unexpected selection policy: {production.get('selectionPolicy')}")

    print("PASS: production SigLIP2 inference matches the Hugging Face AutoProcessor/AutoModel reference path.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
