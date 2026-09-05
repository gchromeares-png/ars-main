from __future__ import annotations

import asyncio
import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from mycdp import input_ as cdp_input


Point = Tuple[float, float]


class CursorPathProvider:
    """Plan smooth cursor paths without introducing another browser engine."""

    def __init__(self, *, helper_path: str | Path | None = None) -> None:
        self._helper = Path(helper_path).expanduser().resolve() if helper_path else Path(__file__).with_name("cursor_path_helper.cjs")
        self._node = os.environ.get("ARES_NODE_EXECUTABLE", "node").strip() or "node"

    def plan(self, start: Point, end: Point, *, preferred: str = "ghost-cursor") -> Dict[str, Any]:
        start = (float(start[0]), float(start[1]))
        end = (float(end[0]), float(end[1]))
        external = self._external(start, end, preferred=preferred)
        if external:
            return external
        return {"provider": "python-bezier", "points": self._python_bezier(start, end)}

    def play_drag(
        self,
        seleniumbase_cdp: Any,
        start: Point,
        end: Point,
        *,
        preferred: str = "ghost-cursor",
        gui_start: Point | None = None,
        gui_end: Point | None = None,
    ) -> Dict[str, Any]:
        plan = self.plan(start, end, preferred=preferred)
        points = self._clean_points(plan.get("points") or [])
        provider = str(plan.get("provider") or "path")
        if len(points) < 2:
            return {"moved": False, "provider": provider, "pointCount": len(points)}

        if self._play_cdp(seleniumbase_cdp, points):
            return {"moved": True, "provider": f"{provider}:cdp", "pointCount": len(points)}

        if gui_start is not None and gui_end is not None:
            gui_plan = self.plan(gui_start, gui_end, preferred=preferred)
            gui_points = self._clean_points(gui_plan.get("points") or [])
            gui_provider = str(gui_plan.get("provider") or provider)
            if len(gui_points) >= 2 and self._play_pyautogui(gui_points):
                return {"moved": True, "provider": f"{gui_provider}:gui", "pointCount": len(gui_points)}
            try:
                seleniumbase_cdp.gui_drag_drop_points(
                    int(round(gui_start[0])), int(round(gui_start[1])),
                    int(round(gui_end[0])), int(round(gui_end[1])),
                    timeframe=0.55,
                )
                return {"moved": True, "provider": "seleniumbase-gui", "pointCount": 2}
            except Exception:
                pass

        return {"moved": False, "provider": provider, "pointCount": len(points)}

    @staticmethod
    def _play_cdp(seleniumbase_cdp: Any, points: List[Point]) -> bool:
        get_tab = getattr(seleniumbase_cdp, "get_active_tab", None)
        get_loop = getattr(seleniumbase_cdp, "get_event_loop", None)
        if not callable(get_tab) or not callable(get_loop):
            return False
        try:
            tab = get_tab()
            loop = get_loop()
        except Exception:
            return False
        if tab is None or loop is None:
            return False

        async def drag() -> None:
            button = cdp_input.MouseButton("left")
            start_x, start_y = points[0]
            await tab.send(cdp_input.dispatch_mouse_event(
                "mouseMoved", x=start_x, y=start_y, button=button, buttons=0
            ))
            await tab.send(cdp_input.dispatch_mouse_event(
                "mousePressed", x=start_x, y=start_y, button=button, buttons=1, click_count=1
            ))
            try:
                for x, y in points[1:]:
                    await tab.send(cdp_input.dispatch_mouse_event(
                        "mouseMoved", x=x, y=y, button=button, buttons=1
                    ))
                    await asyncio.sleep(0)
            finally:
                end_x, end_y = points[-1]
                await tab.send(cdp_input.dispatch_mouse_event(
                    "mouseReleased", x=end_x, y=end_y, button=button, buttons=0, click_count=1
                ))

        try:
            loop.run_until_complete(drag())
            return True
        except Exception:
            return False

    def _external(self, start: Point, end: Point, *, preferred: str) -> Dict[str, Any] | None:
        if not self._helper.exists():
            return None
        payload = json.dumps({
            "start": {"x": start[0], "y": start[1]},
            "end": {"x": end[0], "y": end[1]},
            "preferred": preferred,
            "steps": self._steps(start, end),
        })
        env = dict(os.environ)
        if env.get("ARES_NODE_RUN_AS_NODE", "").strip() == "1":
            env["ELECTRON_RUN_AS_NODE"] = "1"
        try:
            completed = subprocess.run(
                [self._node, str(self._helper)],
                input=payload,
                text=True,
                capture_output=True,
                timeout=2.5,
                env=env,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if completed.returncode != 0 and not completed.stdout.strip():
            return None
        try:
            value = json.loads(completed.stdout.strip() or "{}")
        except json.JSONDecodeError:
            return None
        points = self._clean_points(value.get("points") or [])
        if len(points) < 2:
            return None
        return {"provider": str(value.get("provider") or "external"), "points": points}

    @staticmethod
    def _play_pyautogui(points: List[Point]) -> bool:
        try:
            import pyautogui
        except Exception:
            return False
        try:
            pyautogui.PAUSE = 0
            pyautogui.moveTo(points[0][0], points[0][1], duration=0)
            pyautogui.mouseDown(button="left")
            try:
                duration = max(0.004, min(0.018, 0.42 / max(1, len(points) - 1)))
                for x, y in points[1:]:
                    pyautogui.moveTo(x, y, duration=duration)
            finally:
                pyautogui.mouseUp(button="left")
            return True
        except Exception:
            try:
                pyautogui.mouseUp(button="left")
            except Exception:
                pass
            return False

    @classmethod
    def _python_bezier(cls, start: Point, end: Point) -> List[Point]:
        steps = cls._steps(start, end)
        dx = end[0] - start[0]
        dy = end[1] - start[1]
        distance = max(1.0, math.hypot(dx, dy))
        nx, ny = -dy / distance, dx / distance
        bend = min(36.0, max(7.0, distance * 0.07))
        c1 = (start[0] + dx * 0.33 + nx * bend, start[1] + dy * 0.33 + ny * bend)
        c2 = (start[0] + dx * 0.72 + nx * bend * 0.45, start[1] + dy * 0.72 + ny * bend * 0.45)
        points: List[Point] = []
        for index in range(steps + 1):
            t = index / steps
            u = 1.0 - t
            x = u**3 * start[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t**3 * end[0]
            y = u**3 * start[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t**3 * end[1]
            points.append((x, y))
        return points

    @staticmethod
    def _steps(start: Point, end: Point) -> int:
        distance = math.hypot(end[0] - start[0], end[1] - start[1])
        return max(18, min(72, int(round(18 + distance / 12.0))))

    @staticmethod
    def _clean_points(values: Iterable[Any]) -> List[Point]:
        result: List[Point] = []
        for value in values:
            try:
                if isinstance(value, dict):
                    point = (float(value["x"]), float(value["y"]))
                else:
                    point = (float(value[0]), float(value[1]))
            except (KeyError, TypeError, ValueError, IndexError):
                continue
            if not result or math.hypot(result[-1][0] - point[0], result[-1][1] - point[1]) > 0.01:
                result.append(point)
        return result
