from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

import mycdp
import psutil
from seleniumbase import sb_cdp

from authorized_grid_action_executor import AuthorizedGridActionExecutor
from challenge_state_tracker import ChallengeStateTracker
from site_grid_adapter import GridSiteAdapter


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
        vision_config: Dict[str, Any] | None = None,
    ) -> None:
        self.profile_dir = Path(profile_dir).expanduser().resolve()
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        kwargs: Dict[str, Any] = {"user_data_dir": str(self.profile_dir), "headless": bool(headless)}
        if proxy:
            kwargs["proxy"] = proxy
        if user_agent:
            kwargs["agent"] = user_agent

        self._sb = sb_cdp.Chrome(**kwargs)
        self._challenge_tracker = ChallengeStateTracker(self._sb)
        self._site_adapter = GridSiteAdapter(self._sb, overrides=site_adapter_overrides)
        self._grid_actions = AuthorizedGridActionExecutor(self._sb, self._site_adapter)
        self._vision_runner = self._build_vision_runner(vision_config or {})
        self._last_vision_result: Dict[str, Any] = {"status": "inactive"}
        self._closed = False

    def _build_vision_runner(self, config: Dict[str, Any]) -> Any:
        model_path = str(config.get("modelPath") or "").strip()
        if not model_path:
            return None
        from vision_grid_classifier import VisionGridClassifier
        from vision_grid_runner import VisionGridRunner

        aliases = VisionGridClassifier.load_aliases(str(config.get("aliasesPath") or "").strip() or None)
        threshold = float(config.get("threshold", 0.72))
        return VisionGridRunner(self, VisionGridClassifier(model_path), aliases=aliases, threshold=threshold)

    @property
    def chrome_pid(self) -> int | None:
        driver = getattr(self._sb, "driver", None)
        if hasattr(driver, "cdp_base"):
            driver = driver.cdp_base
        pid = getattr(driver, "_process_pid", None)
        return int(pid) if isinstance(pid, int) else None

    def goto(self, url: str) -> None:
        self._sb.goto(url)
        self._challenge_tracker.wait_for_stable_challenge()
        self._sb.solve_captcha()

    def challenge_state(self) -> Dict[str, Any]:
        return self._challenge_tracker.poll()

    def site_grid_state(self) -> Dict[str, Any]:
        return self._site_adapter.poll()

    def apply_grid_selection(self, indexes: Iterable[int], *, expected_signature: str = "", submit: bool = True) -> Dict[str, Any]:
        return self._grid_actions.apply(indexes, expected_signature=expected_signature, submit=submit)

    def vision_tick(self) -> Dict[str, Any]:
        if self._vision_runner is not None:
            self._last_vision_result = self._vision_runner.tick()
        return self._last_vision_result

    def inspect_session(self) -> Dict[str, Any]:
        return {
            "url": str(self._sb.get_current_url() or ""),
            "title": str(self._sb.get_title() or ""),
            "cookies": self.get_snapshot_cookies(),
            "vision": self._last_vision_result,
        }

    def execute_script(self, script: str) -> Any:
        return self._sb.execute_script(script)

    def execute_async_script(self, script: str) -> Any:
        return self._sb.loop.run_until_complete(self._sb.page.evaluate(script, await_promise=True))

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
        if self._closed:
            return False
        driver = getattr(self._sb, "driver", None)
        if driver is None:
            return False
        if hasattr(driver, "cdp_base"):
            driver = driver.cdp_base
        checker = getattr(driver, "is_running", None)
        try:
            running = checker() is not False if callable(checker) else True
        except Exception:
            return False
        if running:
            for observer in (self._challenge_tracker, self._site_adapter):
                try:
                    observer.poll()
                except Exception:
                    pass
            try:
                self.vision_tick()
            except Exception as exc:
                self._last_vision_result = {"status": "error", "error": str(exc)}
        return running

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
        if cookie.get("partitionKey"):
            raise ValueError("Partitionierte Cookies werden im SeleniumBase-Testpfad nicht umgeschrieben.")
        same_site = str(cookie.get("sameSite") or "Lax")
        same_site = same_site if same_site in {"Strict", "Lax", "None"} else "Lax"
        payload: Dict[str, Any] = {
            "name": str(cookie.get("name") or ""),
            "value": str(cookie.get("value") or ""),
            "domain": str(cookie.get("domain") or ""),
            "path": str(cookie.get("path") or "/"),
            "secure": bool(cookie.get("secure")),
            "httpOnly": bool(cookie.get("httpOnly")),
            "sameSite": same_site,
        }
        try:
            expires = float(cookie.get("expires"))
        except (TypeError, ValueError):
            expires = -1
        if expires > 0:
            payload["expires"] = expires
        if not payload["name"] or not payload["domain"]:
            raise ValueError("Cookie ohne Name oder Domain kann nicht geladen werden.")
        return mycdp.network.CookieParam.from_json(payload)

    @staticmethod
    def _cookie_to_snapshot(cookie: Any) -> Dict[str, Any]:
        if hasattr(cookie, "to_json"):
            raw = cookie.to_json()
        elif isinstance(cookie, dict):
            raw = dict(cookie)
        else:
            raw = {key: getattr(cookie, key) for key in dir(cookie) if not key.startswith("_") and not callable(getattr(cookie, key, None))}

        same_site = raw.get("sameSite") or raw.get("same_site") or "Lax"
        same_site = same_site.to_json() if hasattr(same_site, "to_json") else str(same_site)
        same_site = same_site if same_site in {"Strict", "Lax", "None"} else "Lax"
        expires = raw.get("expires", -1)
        expires = expires.to_json() if hasattr(expires, "to_json") else expires
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
