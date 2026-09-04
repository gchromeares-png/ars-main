from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

import mycdp
import psutil
from seleniumbase import sb_cdp

from challenge_state_tracker import ChallengeStateTracker


class SeleniumBaseCdpAdapter:
    """Single ARES boundary around SeleniumBase Pure CDP / MyCDP.

    ARES worker modules depend on this adapter instead of importing SeleniumBase,
    MyCDP, or Playwright directly. SeleniumBase owns the browser lifecycle.
    Stealthy Playwright Mode is an optional attach to the same SeleniumBase CDP
    session and reuses the existing context/page.
    """

    def __init__(
        self,
        *,
        profile_dir: str | Path,
        headless: bool,
        proxy: str | None = None,
        user_agent: str | None = None,
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

        self._sb = sb_cdp.Chrome(**kwargs)
        self._challenge_tracker = ChallengeStateTracker(self._sb)
        self._closed = False
        self._playwright = None
        self._playwright_browser = None
        self._playwright_context = None
        self._playwright_page = None

    @property
    def chrome_pid(self) -> int | None:
        driver = getattr(self._sb, "driver", None)
        if hasattr(driver, "cdp_base"):
            driver = driver.cdp_base
        pid = getattr(driver, "_process_pid", None)
        return int(pid) if isinstance(pid, int) else None

    @property
    def playwright_attached(self) -> bool:
        return self._playwright_browser is not None and self._playwright_page is not None

    def goto(self, url: str) -> None:
        self._sb.goto(url)
        # No fixed post-navigation sleep. If a challenge structure is already
        # present, observe it until the visible state settles; pages without a
        # challenge return immediately.
        self._challenge_tracker.wait_for_stable_challenge()
        self._sb.solve_captcha()

    def challenge_state(self) -> Dict[str, Any]:
        """Return the latest structure-only challenge observation."""
        return self._challenge_tracker.poll()

    def execute_script(self, script: str) -> Any:
        return self._sb.execute_script(script)

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

    def attach_stealthy_playwright(self) -> Dict[str, Any]:
        """Attach Playwright to SeleniumBase's existing browser over CDP.

        This follows SeleniumBase Stealthy Playwright Mode: SeleniumBase starts
        and owns Chrome; Playwright connects via get_endpoint_url() and reuses
        browser.contexts[0].pages[0]. No second browser or new context is created.
        """
        if self.playwright_attached:
            return self.inspect_stealthy_playwright()

        from playwright.sync_api import sync_playwright

        endpoint_url = self._sb.get_endpoint_url()
        playwright = sync_playwright().start()
        try:
            browser = playwright.chromium.connect_over_cdp(endpoint_url)
            if not browser.contexts:
                raise RuntimeError("Stealthy Playwright fand keinen SeleniumBase Browser-Context.")
            context = browser.contexts[0]
            if not context.pages:
                raise RuntimeError("Stealthy Playwright fand keine SeleniumBase Browser-Page.")
            page = context.pages[0]
        except Exception:
            playwright.stop()
            raise

        self._playwright = playwright
        self._playwright_browser = browser
        self._playwright_context = context
        self._playwright_page = page
        return self.inspect_stealthy_playwright()

    def inspect_stealthy_playwright(self) -> Dict[str, Any]:
        if not self.playwright_attached:
            raise RuntimeError("Stealthy Playwright ist nicht an die SeleniumBase-Session angehängt.")
        context = self._playwright_context
        page = self._playwright_page
        cookies = context.cookies() if context is not None else []
        return {
            "attached": True,
            "url": page.url if page is not None else "",
            "title": page.title() if page is not None else "",
            "cookies": cookies,
        }

    def is_running(self) -> bool:
        if self._closed:
            return False
        driver = getattr(self._sb, "driver", None)
        if driver is None:
            return False
        if hasattr(driver, "cdp_base"):
            driver = driver.cdp_base
        checker = getattr(driver, "is_running", None)
        if callable(checker):
            try:
                running = checker() is not False
            except Exception:
                return False
        else:
            running = True

        # manual_profile_browser calls is_running() continuously. Polling here
        # therefore tracks reloads, manual navigation, iframe appearance, and
        # dynamic grid generations without changing the protected solver core.
        if running:
            try:
                self._challenge_tracker.poll()
            except Exception:
                pass
        return running

    def quit(self) -> None:
        if self._closed:
            return
        self._closed = True
        chrome_pid = self.chrome_pid
        if self._playwright is not None:
            try:
                self._playwright.stop()
            finally:
                self._playwright = None
                self._playwright_browser = None
                self._playwright_context = None
                self._playwright_page = None
        self._sb.quit()
        self._wait_for_profile_flush(chrome_pid)

    @staticmethod
    def _wait_for_profile_flush(chrome_pid: int | None) -> None:
        """Do not reopen a persistent profile while Chrome is still settling.

        SeleniumBase already performs a graceful Pure-CDP browser close. Windows
        can still need a short disk-settle window before the same user-data-dir is
        opened by a new process. Waiting here keeps the lifecycle SeleniumBase-owned
        while preventing an immediate reopen from racing cookie/session persistence.
        """
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
