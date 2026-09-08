from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from observation_capture import ObservationCapture


class FakePolicy:
    max_saved_captures = 8

    @staticmethod
    def capture_enabled(_event: str) -> bool:
        return True


class FakeTab:
    async def save_screenshot(self, *, filename: str, format: str, full_page: bool) -> None:
        assert format == "png"
        assert full_page is False
        Path(filename).write_bytes(b"ACTIVE-TAB")


class FakeSeleniumBase:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.sync_calls = 0
        self.active_calls = 0

    def get_active_tab(self) -> FakeTab:
        self.active_calls += 1
        return FakeTab()

    def get_event_loop(self):
        return self.loop

    def save_screenshot(self, filename: str, *, folder: str) -> None:
        self.sync_calls += 1
        Path(folder, filename).write_bytes(b"STALE-CACHED-PAGE")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="ares-active-tab-capture-") as temporary:
        sb = FakeSeleniumBase()
        try:
            capture = ObservationCapture(sb, profile_dir=temporary, policy=FakePolicy())
            result = capture.capture("grid-candidate", generation=7, force=True)

            assert result["captured"] is True, result
            assert result["provider"] == "active-tab-cdp", result
            assert sb.active_calls == 1, sb.active_calls
            assert sb.sync_calls == 0, "successful active-tab capture must not touch stale sync wrapper"
            assert Path(result["path"]).read_bytes() == b"ACTIVE-TAB"
        finally:
            sb.loop.close()

    print("observation_capture_active_tab_probe: PASS")


if __name__ == "__main__":
    main()
