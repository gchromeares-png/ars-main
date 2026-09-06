from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROBE = ROOT / "siglip_calibration_latency_probe.py"


def main() -> int:
    completed = subprocess.run(
        [sys.executable, str(PROBE)],
        cwd=str(ROOT),
        env=dict(os.environ),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    output = completed.stdout or ""
    print(output, end="")
    if completed.returncode != 0:
        raise AssertionError(f"SigLIP2 Hugging Face reference parity probe failed with exit code {completed.returncode}")
    if "PASS: production SigLIP2 inference matches the Hugging Face AutoProcessor/AutoModel reference path." not in output:
        raise AssertionError("SigLIP2 reference parity probe did not report a passing reference-path result")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
