from __future__ import annotations

import os
import platform
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict
from urllib.parse import urlencode

import browser_identity_probe as base
from seleniumbase_adapter import SeleniumBaseCdpAdapter


def _collect_seed(
    adapter: SeleniumBaseCdpAdapter,
    *,
    run_index: int,
    seed: int,
    http_headers: Dict[str, str],
    probe_url: str,
) -> Dict[str, Any]:
    adapter.execute_script(base.COLLECT_SCRIPT, int(seed))
    deadline = time.monotonic() + 8.0
    payload: Dict[str, Any] | None = None
    last_error = ""
    while time.monotonic() < deadline:
        try:
            error = adapter.execute_script("return window.__aresIdentityError || '';")
            if error:
                last_error = str(error)
                break
            result = adapter.execute_script("return window.__aresIdentityResult;")
            if isinstance(result, dict):
                payload = dict(result)
                break
        except Exception as exc:
            last_error = str(exc)
        time.sleep(0.05)
    if payload is None:
        raise RuntimeError(f"identity collector timed out for seed {seed}: {last_error or 'no result'}")
    payload["http"] = dict(http_headers)
    payload["url"] = probe_url
    payload["run"] = int(run_index)
    return payload


def _run_browser_pass(server: base.ProbeServer, *, run_index: int, profile_root: Path) -> Dict[str, Any]:
    profile_dir = profile_root / f"run-{run_index}"
    profile_dir.mkdir(parents=True, exist_ok=True)
    adapter = SeleniumBaseCdpAdapter(profile_dir=profile_dir, headless=False)
    try:
        token = f"r{run_index}-{time.time_ns()}"
        prime_url = f"{server.base_url}/prime"
        probe_url = f"{server.base_url}/probe?{urlencode({'token': token})}"

        # Identity proof needs the real headed sb_cdp browser, not the expensive
        # ARES navigation/challenge/watchdog pipeline for every measurement seed.
        # Prime Accept-CH once, then make one measured request. The three seeds
        # change only the read-only rendering stimulus on that already-loaded page.
        adapter._sb.goto(prime_url)
        adapter._sb.goto(probe_url)
        http_headers = server.headers_for(token)
        if not http_headers:
            raise RuntimeError("identity HTTP request headers were not observed")

        measurements = [
            _collect_seed(
                adapter,
                run_index=run_index,
                seed=seed,
                http_headers=http_headers,
                probe_url=f"{server.base_url}/probe",
            )
            for seed in base.SEEDS
        ]
        return {
            "run": int(run_index),
            "measurements": measurements,
            "runtime": {
                "chromePidObserved": bool(adapter.chrome_pid),
                "metadataKeys": sorted(adapter.runtime_metadata().keys()),
            },
        }
    finally:
        adapter.quit()


def main() -> int:
    artifact = Path(os.environ.get(base.ARTIFACT_ENV) or base.DEFAULT_ARTIFACT)
    started_at = time.time()
    report: Dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "ares-browser-identity-proof",
        "head": os.environ.get("GITHUB_SHA") or "",
        "runner": {
            "os": platform.platform(),
            "python": sys.version.split()[0],
            "githubActions": os.environ.get("GITHUB_ACTIONS") == "true",
            "runnerName": os.environ.get("RUNNER_NAME") or "",
            "runnerEnvironment": os.environ.get("RUNNER_ENVIRONMENT") or "",
        },
        "seeds": list(base.SEEDS),
        "coverage": {
            "httpJsUserAgentParity": "TESTED",
            "clientHintsParity": "TESTED_WHEN_EXPOSED",
            "languageParity": "TESTED",
            "javascriptRuntime": "TESTED",
            "canvasSeededStability": "TESTED",
            "webglSeededStability": "TESTED",
            "fontMetricsSeededStability": "TESTED",
            "clientRectsSeededStability": "TESTED",
            "browserFeatureSurface": "RECORDED",
            "tlsJa3Ja4": "NOT_TESTED_LOCAL_ORIGIN",
            "http2Http3": "NOT_TESTED_LOCAL_ORIGIN",
            "publicIpIpv6Dns": "NOT_TESTED_LOCAL_ORIGIN",
            "webrtcAddressLeak": "NOT_TESTED_PRIVACY_SENSITIVE",
            "realGpuParity": "REQUIRES_SELF_HOSTED_RUNNER",
        },
        "runs": [],
        "checks": [],
    }

    server = base.ProbeServer()
    server.start()
    try:
        with tempfile.TemporaryDirectory(prefix="ares-browser-identity-") as temporary:
            root = Path(temporary)
            report["runs"].append(_run_browser_pass(server, run_index=1, profile_root=root))
            report["runs"].append(_run_browser_pass(server, run_index=2, profile_root=root))
        report["checks"] = base._evaluate(report["runs"])
    except BaseException as exc:
        report["fatalError"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        server.close()
        report["durationMs"] = round((time.time() - started_at) * 1000.0, 3)
        statuses = [str(item.get("status") or "") for item in report.get("checks") or []]
        report["summary"] = {
            "pass": statuses.count("PASS"),
            "warn": statuses.count("WARN"),
            "fail": statuses.count("FAIL") + (1 if "fatalError" in report else 0),
        }
        base._write_report(report, artifact)

    summary = report["summary"]
    print(
        "ARES_BROWSER_IDENTITY_PROOF "
        f"pass={summary['pass']} warn={summary['warn']} fail={summary['fail']} "
        f"durationMs={report['durationMs']} artifact={artifact.as_posix()}",
        flush=True,
    )
    return 1 if int(summary["fail"]) > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
