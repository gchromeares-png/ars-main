from __future__ import annotations

import json
import os
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
        driver = getattr(self._sb, "driver", None)
        if driver is None:
            return None
        if hasattr(driver, "cdp_base"):
            driver = driver.cdp_base
        pid = getattr(driver, "_process_pid", None)
        return int(pid) if isinstance(pid, int) and pid > 0 else None

    def _profile_browser_pids(self) -> List[int]:
        target = os.path.normcase(str(self.profile_dir))
        matches: List[int] = []
        for process in psutil.process_iter(["pid", "cmdline"]):
            try:
                command_line = [str(value) for value in (process.info.get("cmdline") or [])]
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.Error):
                continue
            for index, argument in enumerate(command_line):
                profile_value = ""
                if argument.startswith("--user-data-dir="):
                    profile_value = argument.split("=", 1)[1]
                elif argument == "--user-data-dir" and index + 1 < len(command_line):
                    profile_value = command_line[index + 1]
                if not profile_value:
                    continue
                clean = profile_value.strip().strip('"')
                try:
                    candidate = os.path.normcase(str(Path(clean).expanduser().resolve()))
                except (OSError, RuntimeError):
                    candidate = os.path.normcase(os.path.abspath(os.path.expanduser(clean)))
                if candidate == target:
                    matches.append(int(process.pid))
                    break
        return matches

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
        if not args:
            return self._sb.execute_script(script)
        encoded_args = json.dumps(list(args), ensure_ascii=False, separators=(",", ":"))
        wrapped = (
            "(() => {"
            f"const __aresArgs={encoded_args};"
            "return (function(){"
            f"{script}"
            "}).apply(null,__aresArgs);"
            "})()"
        )
        return self._sb.execute_script(wrapped)

    def sleep(self, seconds: float) -> None:
        self._sb.sleep(seconds)

    def set_snapshot_cookies(self, cookies: Iterable[Dict[str, Any]]) -> int:
        params = [self._cookie_param(dict(cookie)) for cookie in cookies]
        if not params:
            return 0
        self._sb.set_all_cookies(params)
        # CDP-injected persistent cookies can become request-visible before
        # Chromium commits them to the profile cookie database. Force a browser
        # readback and give Windows a short settle window before an immediate
        # clean close/reopen of the same SeleniumBase profile.
        try:
            self._sb.get_all_cookies()
        except Exception:
            pass
        if sys.platform.startswith("win"):
            time.sleep(1.0)
        return len(params)

    def get_snapshot_cookies(self) -> List[Dict[str, Any]]:
        return [self._cookie_to_snapshot(cookie) for cookie in self._sb.get_all_cookies()]

    def is_running(self) -> bool:
        if self._closed:
            return False
        pid = self.chrome_pid
        if not pid:
            return True
        try:
            process = psutil.Process(pid)
            return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False
        except (psutil.AccessDenied, psutil.Error):
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
        try:
            self._capture_for_events(state)
        except Exception:
            pass
        try:
            self._orchestrator.run_cycle(self._run_visual_auto, self._run_instruction_auto)
        except Exception:
            pass

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

    def _request_graceful_browser_close(self) -> bool:
        driver = getattr(self._sb, "driver", None)
        if driver is None:
            return False
        if hasattr(driver, "cdp_base"):
            driver = driver.cdp_base
        loop = getattr(self._sb, "loop", None)
        send = getattr(driver, "send", None)
        if loop is None or not callable(send):
            return False
        try:
            loop.run_until_complete(send(mycdp.browser.close()))
            return True
        except Exception:
            return False

    def quit(self) -> None:
        if self._closed:
            return
        self._closed = True
        browser_pids = self._profile_browser_pids()
        chrome_pid = self.chrome_pid
        if chrome_pid and chrome_pid not in browser_pids:
            browser_pids.insert(0, chrome_pid)
        try:
            self._sb.get_all_cookies()
        except Exception:
            pass
        # SeleniumBase's underlying Pure-CDP stop path can terminate Chromium
        # directly. Ask Chromium itself to close first so Windows can commit the
        # profile cookie database and local storage before any hard fallback.
        time.sleep(1.0 if sys.platform.startswith("win") else 0.2)
        graceful_close = self._request_graceful_browser_close()
        if graceful_close:
            self._wait_for_profile_flush(browser_pids)
            return
        self._sb.quit()
        self._wait_for_profile_flush(browser_pids)

    @staticmethod
    def _wait_for_profile_flush(browser_pids: Iterable[int]) -> None:
        pids = list(dict.fromkeys(int(pid) for pid in browser_pids if isinstance(pid, int) and pid > 0))
        if not pids:
            time.sleep(1.0)
            return
        chrome_pid = pids[0]
        try:
            psutil.Process(chrome_pid).wait(timeout=5.0)
        except psutil.NoSuchProcess:
            pass
        except (psutil.TimeoutExpired, psutil.AccessDenied, psutil.Error):
            pass
        deadline = time.monotonic() + 5.0
        for pid in pids[1:]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                psutil.Process(pid).wait(timeout=remaining)
            except psutil.NoSuchProcess:
                pass
            except (psutil.TimeoutExpired, psutil.AccessDenied, psutil.Error):
                continue
        time.sleep(0.25)

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
        same_site = raw.get("sameSite") or raw.get("same_site") or "Lax"
        if hasattr(same_site, "to_json"):
            same_site = same_site.to_json()
        same_site = str(same_site)
        if same_site not in {"Strict", "Lax", "None"}:
            same_site = "Lax"
        expires = raw.get("expires", -1)
        if hasattr(expires, "to_json"):
            expires = expires.to_json()
        try:
            expires_number = float(expires)
        except (TypeError, ValueError):
            expires_number = -1
        snapshot: Dict[str, Any] = {
            "name": str(raw.get("name") or ""),
            "value": str(raw.get("value") or ""),
            "domain": str(raw.get("domain") or ""),
            "path": str(raw.get("path") or "/"),
            "expires": expires_number,
            "httpOnly": bool(raw.get("httpOnly", raw.get("http_only", False))),
            "secure": bool(raw.get("secure", False)),
            "sameSite": same_site,
        }
        partition_key = raw.get("partitionKey") or raw.get("partition_key")
        if isinstance(partition_key, str) and partition_key.strip():
            snapshot["partitionKey"] = partition_key.strip()
        elif isinstance(partition_key, dict) and partition_key.get("topLevelSite"):
            snapshot["partitionKey"] = str(partition_key["topLevelSite"])
        return snapshot
