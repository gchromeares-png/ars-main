from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterable, List

import mycdp
from seleniumbase import sb_cdp


class SeleniumBaseCdpAdapter:
    """Single ARES boundary around SeleniumBase Pure CDP / MyCDP.

    ARES worker modules must depend on this adapter instead of importing
    SeleniumBase or MyCDP directly. SeleniumBase itself remains an external,
    unmodified dependency.
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
        self._closed = False

    @property
    def chrome_pid(self) -> int | None:
        driver = getattr(self._sb, "driver", None)
        if hasattr(driver, "cdp_base"):
            driver = driver.cdp_base
        pid = getattr(driver, "_process_pid", None)
        return int(pid) if isinstance(pid, int) else None

    def goto(self, url: str) -> None:
        self._sb.goto(url)

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
                return checker() is not False
            except Exception:
                return False
        return True

    def quit(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._sb.quit()

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
