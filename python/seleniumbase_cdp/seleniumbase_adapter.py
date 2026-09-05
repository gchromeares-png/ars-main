from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

import mycdp
import psutil
from seleniumbase import sb_cdp

from challenge_state_tracker import ChallengeStateTracker
from instruction_input_runtime import InstructionInputRuntime
from interaction_orchestrator import InteractionOrchestrator
from interaction_outcome import from_semantic_result, from_visual_result
from interaction_policy import InteractionPolicy
from observation_capture import ObservationCapture
from page_observation_watchdog import PageObservationWatchdog
from semantic_interaction_runtime import SemanticInteractionRuntime
from visual_interaction_runtime import VisualInteractionRuntime


class SeleniumBaseCdpAdapter:
    """Single ARES boundary around SeleniumBase Pure CDP / MyCDP."""

    def __init__(
        self,
        *,
        profile_dir: str | Path,
        headless: bool,
        proxy: str | None = None,
        user_agent: str | None = None,
        site_adapter_overrides: Dict[str, str] | None = None,
        browser_args: Iterable[str] | None = None,
        language: str | None = None,
        timezone: str | None = None,
    ) -> None:
        self.profile_dir = Path(profile_dir).expanduser().resolve()
        self.profile_dir.mkdir(parents=True, exist_ok=True)

        kwargs: Dict[str, Any] = {
            "user_data_dir": str(self.profile_dir),
            "headless": bool(headless),
        }
        if proxy:
            kwargs["proxy"] = proxy
        if user_agent:
            kwargs["agent"] = user_agent
        clean_args = [str(value).strip() for value in (browser_args or []) if str(value).strip()]
        if clean_args:
            kwargs["browser_args"] = clean_args
        if language:
            kwargs["lang"] = str(language)
        if timezone:
            kwargs["tzone"] = str(timezone)

        self._sb = sb_cdp.Chrome(**kwargs)
        self._challenge_tracker = ChallengeStateTracker(self._sb)
        self._visual_interactions = VisualInteractionRuntime(
            self._sb,
            profile_dir=self.profile_dir,
            overrides=site_adapter_overrides or {},
        )
        self._semantic_interactions = SemanticInteractionRuntime(self._sb)
        self._instruction_inputs = InstructionInputRuntime(self._sb)
        self._orchestrator = InteractionOrchestrator()
        self._policy = InteractionPolicy.from_profile(self.profile_dir)
        self._watchdog = PageObservationWatchdog(self._sb, self._policy)
        self._capture = ObservationCapture(self._sb, profile_dir=self.profile_dir, policy=self._policy)
        self._next_watchdog_poll = 0.0
        self._last_watchdog_state: Dict[str, Any] = {}
        self._last_auto_result: Dict[str, Any] = {
            "acted": False,
            "kind": "none",
            "outcome": from_visual_result({"acted": False, "kind": "none"}),
        }
        self._last_instruction_result: Dict[str, Any] = {
            "acted": False,
            "verified": False,
            "kind": "instruction-input",
            "reason": "not-run",
        }
        self._last_semantic_outcome: Dict[str, Any] = from_semantic_result({"results": []})
        self._closed = False

    @property
    def chrome_pid(self) -> int | None:
        candidates = [getattr(self._sb, "driver", None), self._sb]
        for candidate in candidates:
            if candidate is None:
                continue
            if hasattr(candidate, "cdp_base"):
                candidate = candidate.cdp_base
            for attribute in ("_process_pid", "process_pid", "pid"):
                pid = getattr(candidate, attribute, None)
                if isinstance(pid, int) and pid > 0:
                    return pid
        return None

    def goto(self, url: str) -> None:
        self._sb.goto(url)
        self._challenge_tracker.wait_for_stable_challenge()
        self._sb.solve_captcha()

        self._watchdog.reset()
        initial = self._watchdog.poll()
        self._last_watchdog_state = initial
        self._capture.capture("page-load", generation=int(initial.get("generation") or 0))
        self._poll_observation_watchdog(force=True)

    def challenge_state(self) -> Dict[str, Any]:
        return self._challenge_tracker.poll()

    def site_grid_state(self) -> Dict[str, Any]:
        return self._visual_interactions.grid_state()

    def site_slider_state(self) -> Dict[str, Any]:
        return self._visual_interactions.slider_state()

    def slider_target_state(self) -> Dict[str, Any]:
        return self._visual_interactions.slider_target_state()

    def auto_interaction_state(self) -> Dict[str, Any]:
        return {
            **self._visual_interactions.status(),
            "lastResult": self._last_auto_result,
            "lastInstructionResult": self._last_instruction_result,
            "instructionInputsEnabled": True,
            "orchestrator": self._orchestrator.status(),
            "watchdog": self._watchdog.status(),
            "policy": self._policy.status(),
            "capture": self._capture.status(),
        }

    def interaction_outcome_state(self) -> Dict[str, Any]:
        return {
            "enabled": True,
            "mode": "event-driven-default",
            "semantic": self._last_semantic_outcome,
            "visual": self._last_auto_result.get("outcome", from_visual_result(self._last_auto_result)),
            "instructionInput": self._last_instruction_result,
            "orchestrator": self._orchestrator.status(),
            "watchdog": self._last_watchdog_state,
        }

    def observe_semantic_fields(self) -> List[Dict[str, Any]]:
        return self._semantic_interactions.observe_fields()

    def execute_semantic_plan(self, plan: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
        items = [dict(item) for item in plan]

        def action() -> Dict[str, Any]:
            result = self._semantic_interactions.execute_plan(items)
            outcome = from_semantic_result(result)
            self._last_semantic_outcome = outcome
            return {**result, "outcome": outcome}

        return self._orchestrator.run_action("semantic", action)

    def apply_grid_selection(self, indexes: Iterable[int], *, submit: bool = True) -> Dict[str, Any]:
        selected = list(indexes)

        def action() -> Dict[str, Any]:
            result = self._visual_interactions.apply_grid_selection(selected, submit=submit)
            return {**result, "outcome": from_visual_result(result)}

        return self._orchestrator.run_action("grid", action)

    def apply_slider(self, target_fraction: float = 0.96) -> Dict[str, Any]:
        def action() -> Dict[str, Any]:
            result = self._visual_interactions.apply_slider(target_fraction)
            return {**result, "outcome": from_visual_result(result)}

        return self._orchestrator.run_action("slider", action)

    def inspect_session(self) -> Dict[str, Any]:
        return {
            "url": str(self._sb.get_current_url() or ""),
            "title": str(self._sb.get_title() or ""),
            "cookies": self.get_snapshot_cookies(),
            "interactionOutcome": self.interaction_outcome_state(),
        }

    def execute_script(self, script: str, *args: Any) -> Any:
        return self._sb.execute_script(script, *args)

    def sleep(self, seconds: float) -> None:
        self._sb.sleep(seconds)

    def set_snapshot_cookies(self, cookies: Iterable[Dict[str, Any]]) -> int:
        params = [self._cookie_param(dict(cookie)) for cookie in cookies]
        if not params:
            return 0
        self._sb.set_all_cookies(params)
        return len(params)

    def get_snapshot_cookies(self) -> List[Dict[str, Any]]:
        return [self._cookie_to_snapshot(cookie) for cookie in self._sb.get_all_cookies()]

    def is_running(self) -> bool:
        """Return False only when ARES has positive evidence that Chrome is gone.

        Pure-CDP SeleniumBase builds do not consistently expose a ``.driver`` wrapper.
        Treating a missing wrapper as a dead browser races the explicit READY handshake:
        the worker can emit READY and then exit before Node issues its first RPC.  The
        adapter itself is the browser owner, so absence of an optional wrapper is not
        evidence of browser termination.
        """
        if self._closed:
            return False

        pid = self.chrome_pid
        if pid:
            try:
                process = psutil.Process(pid)
                if not process.is_running() or process.status() == psutil.STATUS_ZOMBIE:
                    return False
            except psutil.NoSuchProcess:
                return False
            except (psutil.AccessDenied, psutil.Error):
                # An inaccessible process is not proof that the SeleniumBase session died.
                pass

        # Keep observation work best-effort. Transient CDP/navigation failures must not
        # collapse the browser-owner process; RPC operations surface actionable errors.
        try:
            self._challenge_tracker.poll()
        except Exception:
            pass
        self._poll_observation_watchdog()
        return True

    def _poll_observation_watchdog(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now < self._next_watchdog_poll:
            return
        self._next_watchdog_poll = now + self._policy.watchdog_interval_seconds

        try:
            state = self._watchdog.poll()
        except Exception:
            return
        self._last_watchdog_state = state
        if not force and not bool(state.get("changed")):
            return

        self._capture_for_events(state)
        self._orchestrator.run_cycle(self._run_visual_auto, self._run_instruction_auto)

    def _capture_for_events(self, state: Dict[str, Any]) -> None:
        generation = int(state.get("generation") or 0)
        events = [str(event) for event in state.get("events") or []]
        priority = (
            "navigation",
            "iframe-added",
            "modal-opened",
            "grid-candidate",
            "slider-candidate",
            "canvas-candidate",
            "layout-generation-changed",
        )
        for event in priority:
            if event in events and self._policy.capture_enabled(event):
                self._capture.capture(event, generation=generation)
                return

    def _run_visual_auto(self) -> Dict[str, Any]:
        try:
            result = self._visual_interactions.poll_and_act()
            self._last_auto_result = {**result, "outcome": from_visual_result(result)}
            if bool(result.get("acted")) and result.get("verified") is False:
                generation = int(self._last_watchdog_state.get("generation") or 0)
                self._capture.capture("verification-failure", generation=generation)
        except Exception as exc:
            result = {"acted": False, "kind": "error", "error": str(exc)}
            self._last_auto_result = {**result, "outcome": from_visual_result(result)}
        return self._last_auto_result

    def _run_instruction_auto(self) -> Dict[str, Any]:
        try:
            self._last_instruction_result = self._instruction_inputs.apply()
        except Exception as exc:
            self._last_instruction_result = {
                "acted": False,
                "verified": False,
                "kind": "instruction-input",
                "reason": "error",
                "error": str(exc),
            }
        return self._last_instruction_result

    def quit(self) -> None:
        if self._closed:
            return
        self._closed = True
        chrome_pid = self.chrome_pid
        self._sb.quit()
        self._wait_for_profile_flush(chrome_pid)

    @staticmethod
    def _wait_for_profile_flush(chrome_pid: int | None) -> None:
        if chrome_pid:
            try:
                psutil.Process(chrome_pid).wait(timeout=5.0)
            except (psutil.NoSuchProcess, psutil.TimeoutExpired):
                pass
        time.sleep(1.0 if sys.platform.startswith("win") else 0.2)

    @staticmethod
    def _cookie_param(cookie: Dict[str, Any]) -> mycdp.network.CookieParam:
        partition_key = cookie.get("partitionKey")
        if partition_key:
            raise ValueError(
                "Partitionierte Cookies werden im SeleniumBase-Testpfad nicht stillschweigend umgeschrieben. "
                "Bitte Snapshot ohne partitionKey verwenden."
            )

        same_site = str(cookie.get("sameSite") or "Lax")
        if same_site not in {"Strict", "Lax", "None"}:
            same_site = "Lax"

        payload: Dict[str, Any] = {
            "name": str(cookie.get("name") or ""),
            "value": str(cookie.get("value") or ""),
            "domain": str(cookie.get("domain") or ""),
            "path": str(cookie.get("path") or "/"),
            "secure": bool(cookie.get("secure")),
            "httpOnly": bool(cookie.get("httpOnly")),
            "sameSite": same_site,
        }
        expires = cookie.get("expires")
        try:
            expires_number = float(expires)
        except (TypeError, ValueError):
            expires_number = -1
        if expires_number > 0:
            payload["expires"] = expires_number

        if not payload["name"] or not payload["domain"]:
            raise ValueError("Cookie ohne Name oder Domain kann nicht in SeleniumBase geladen werden.")
        return mycdp.network.CookieParam.from_json(payload)

    @staticmethod
    def _cookie_to_snapshot(cookie: Any) -> Dict[str, Any]:
        if hasattr(cookie, "to_json"):
            raw = cookie.to_json()
        elif isinstance(cookie, dict):
            raw = dict(cookie)
        else:
            raw = {
                key: getattr(cookie, key)
                for key in dir(cookie)
                if not key.startswith("_") and not callable(getattr(cookie, key, None))
            }

        return {
            "name": str(raw.get("name") or ""),
            "value": str(raw.get("value") or ""),
            "domain": str(raw.get("domain") or ""),
            "path": str(raw.get("path") or "/"),
            "expires": float(raw.get("expires") or -1),
            "httpOnly": bool(raw.get("httpOnly")),
            "secure": bool(raw.get("secure")),
            "sameSite": str(raw.get("sameSite") or "Lax"),
        }
