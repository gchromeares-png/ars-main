from __future__ import annotations

import asyncio
import json
import math
import os
import random
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from mycdp import input_ as cdp_input

Point = Tuple[float, float]


class CursorPathProvider:
    """Plan and play smooth cursor paths through the existing CDP session.

    Each runtime instance owns an in-memory random stream. Because a
    VisualInteractionRuntime creates exactly one provider for its browser/task
    session, parallel tasks get independent motion streams automatically. The
    stream is never persisted, derived from a proxy, or exposed through the UI;
    a fresh provider therefore starts with fresh motion on every task restart.
    """

    def __init__(self, *, helper_path: str | Path | None = None) -> None:
        self._helper = Path(helper_path).expanduser().resolve() if helper_path else Path(__file__).with_name("cursor_path_helper.cjs")
        self._node = os.environ.get("ARES_NODE_EXECUTABLE", "node").strip() or "node"
        # Session-local only: no profile/config/database persistence. 256 bits of
        # fresh entropy makes independently-created task runtimes practically
        # certain to have different path variations.
        self._rng = random.Random(int.from_bytes(os.urandom(32), "big"))
        self._movement_index = 0

    def plan(self, start: Point, end: Point, *, preferred: str = "ghost-cursor") -> Dict[str, Any]:
        start = (float(start[0]), float(start[1]))
        end = (float(end[0]), float(end[1]))
        external = self._external(start, end, preferred=preferred)
        if external:
            external["points"] = self._sessionize_points(external.get("points") or [], start, end)
            return external
        points = self._sessionize_points(self._python_bezier(start, end), start, end)
        return {"provider": "python-bezier", "points": points}

    def _sessionize_points(self, values: Iterable[Any], start: Point, end: Point) -> List[Point]:
        """Apply tiny bounded per-movement variation while preserving endpoints.

        The variation is deliberately small (sub-pixel to ~1.5px) so it changes
        the shape without changing the requested target or reducing reliability.
        Endpoints are copied exactly, which keeps slider/grid hit geometry intact.
        """
        points = self._clean_points(values)
        if len(points) < 3:
            return points

        self._movement_index += 1
        dx, dy = end[0] - start[0], end[1] - start[1]
        distance = max(1.0, math.hypot(dx, dy))
        nx, ny = -dy / distance, dx / distance
        amplitude = self._rng.uniform(0.45, 1.45)
        phase = self._rng.uniform(-0.45, 0.45)
        result: List[Point] = [start]
        denominator = max(1, len(points) - 1)

        for index, (x, y) in enumerate(points[1:-1], start=1):
            t = index / denominator
            # Zero at both ends; strongest only in the middle of the path.
            envelope = 4.0 * t * (1.0 - t)
            wave = math.sin(math.pi * t + phase)
            micro = self._rng.uniform(-0.20, 0.20)
            offset = envelope * (amplitude * wave + micro)
            result.append((x + nx * offset, y + ny * offset))

        result.append(end)
        return self._clean_points(result)

    def play_click(self, seleniumbase_cdp: Any, start: Point, end: Point, *, preferred: str = "ghost-cursor") -> Dict[str, Any]:
        plan = self.plan(start, end, preferred=preferred)
        points = self._clean_points(plan.get("points") or [])
        provider = str(plan.get("provider") or "path")
        if not points:
            return {"clicked": False, "provider": provider, "pointCount": 0}
        if self._play_cdp_click(seleniumbase_cdp, points):
            return {"clicked": True, "provider": f"{provider}:cdp", "pointCount": len(points)}
        return {"clicked": False, "provider": provider, "pointCount": len(points)}

    def play_drag(
        self,
        seleniumbase_cdp: Any,
        start: Point,
        end: Point,
        *,
        preferred: str = "ghost-cursor",
        gui_start: Point | None = None,
        gui_end: Point | None = None,
        end_hold_backtrack: bool = False,
    ) -> Dict[str, Any]:
        plan = self.plan(start, end, preferred=preferred)
        points = self._clean_points(plan.get("points") or [])
        provider = str(plan.get("provider") or "path")
        if len(points) < 2:
            return {"moved": False, "provider": provider, "pointCount": len(points)}
        profile = self._rng.randrange(4)
        if self._play_cdp_drag(
            seleniumbase_cdp,
            points,
            profile=profile,
            end_hold_backtrack=end_hold_backtrack,
        ):
            return {
                "moved": True,
                "provider": f"{provider}:cdp",
                "pointCount": len(points),
                "dragProfile": profile + 1,
                "endHoldBacktrack": bool(end_hold_backtrack),
            }
        if gui_start is not None and gui_end is not None:
            gui_plan = self.plan(gui_start, gui_end, preferred=preferred)
            gui_points = self._clean_points(gui_plan.get("points") or [])
            gui_provider = str(gui_plan.get("provider") or provider)
            if len(gui_points) >= 2 and self._play_pyautogui(gui_points):
                return {"moved": True, "provider": f"{gui_provider}:gui", "pointCount": len(gui_points)}
            try:
                seleniumbase_cdp.gui_drag_drop_points(int(round(gui_start[0])), int(round(gui_start[1])), int(round(gui_end[0])), int(round(gui_end[1])), timeframe=0.55)
                return {"moved": True, "provider": "seleniumbase-gui", "pointCount": 2}
            except Exception:
                pass
        return {"moved": False, "provider": provider, "pointCount": len(points)}

    @staticmethod
    def _cdp_context(seleniumbase_cdp: Any):
        get_tab = getattr(seleniumbase_cdp, "get_active_tab", None)
        get_loop = getattr(seleniumbase_cdp, "get_event_loop", None)
        if not callable(get_tab) or not callable(get_loop):
            return None
        try:
            tab, loop = get_tab(), get_loop()
        except Exception:
            return None
        return None if tab is None or loop is None else (tab, loop)

    @classmethod
    def _play_cdp_click(cls, seleniumbase_cdp: Any, points: List[Point]) -> bool:
        context = cls._cdp_context(seleniumbase_cdp)
        if context is None:
            return False
        tab, loop = context

        async def click() -> None:
            button = cdp_input.MouseButton("left")
            for x, y in points:
                await tab.send(cdp_input.dispatch_mouse_event("mouseMoved", x=x, y=y, button=button, buttons=0))
                await asyncio.sleep(0)
            x, y = points[-1]
            await tab.send(cdp_input.dispatch_mouse_event("mousePressed", x=x, y=y, button=button, buttons=1, click_count=1))
            await tab.send(cdp_input.dispatch_mouse_event("mouseReleased", x=x, y=y, button=button, buttons=0, click_count=1))

        try:
            loop.run_until_complete(click())
            return True
        except Exception:
            return False

    @classmethod
    def _play_cdp_drag(
        cls,
        seleniumbase_cdp: Any,
        points: List[Point],
        *,
        profile: int = 0,
        end_hold_backtrack: bool = False,
    ) -> bool:
        context = cls._cdp_context(seleniumbase_cdp)
        if context is None:
            return False
        tab, loop = context

        async def drag() -> None:
            button = cdp_input.MouseButton("left")
            sx, sy = points[0]
            await tab.send(cdp_input.dispatch_mouse_event("mouseMoved", x=sx, y=sy, button=button, buttons=0))
            await asyncio.sleep(0.035 + profile * 0.008)
            await tab.send(cdp_input.dispatch_mouse_event("mousePressed", x=sx, y=sy, button=button, buttons=1, click_count=1))
            await asyncio.sleep((0.045, 0.065, 0.055, 0.075)[profile])
            ex, ey = points[-1]
            try:
                count = max(1, len(points) - 1)
                for index, (x, y) in enumerate(points[1:], start=1):
                    t = index / count
                    if profile == 0:
                        delay = 0.010 + 0.010 * t
                    elif profile == 1:
                        delay = 0.008 + 0.018 * (t * t)
                    elif profile == 2:
                        delay = 0.012 + 0.006 * abs(math.sin(t * math.pi * 2.0))
                    else:
                        delay = 0.009 + (0.020 if t > 0.72 else 0.006 * t)
                    await tab.send(cdp_input.dispatch_mouse_event("mouseMoved", x=x, y=y, button=button, buttons=1))
                    await asyncio.sleep(delay)

                ex, ey = points[-1]
                if end_hold_backtrack:
                    await asyncio.sleep((0.10, 0.14, 0.12, 0.16)[profile])
                    px, py = points[-2]
                    dx, dy = ex - px, ey - py
                    length = max(1e-6, math.hypot(dx, dy))
                    back = 1.0 if profile in (0, 2) else 2.0
                    bx = ex - dx / length * back
                    by = ey - dy / length * back
                    await tab.send(cdp_input.dispatch_mouse_event("mouseMoved", x=bx, y=by, button=button, buttons=1))
                    await asyncio.sleep((0.045, 0.060, 0.050, 0.070)[profile])
                    ex, ey = bx, by
            finally:
                await tab.send(cdp_input.dispatch_mouse_event("mouseReleased", x=ex, y=ey, button=button, buttons=0, click_count=1))

        try:
            loop.run_until_complete(drag())
            return True
        except Exception:
            return False

    _play_cdp = _play_cdp_drag

    def _external(self, start: Point, end: Point, *, preferred: str):
        if not self._helper.exists():
            return None
        payload = json.dumps({"start": {"x": start[0], "y": start[1]}, "end": {"x": end[0], "y": end[1]}, "preferred": preferred, "steps": self._steps(start, end)})
        env = dict(os.environ)
        if env.get("ARES_NODE_RUN_AS_NODE", "").strip() == "1":
            env["ELECTRON_RUN_AS_NODE"] = "1"
        try:
            completed = subprocess.run([self._node, str(self._helper)], input=payload, text=True, capture_output=True, timeout=2.5, env=env, check=False)
        except (OSError, subprocess.SubprocessError):
            return None
        if completed.returncode != 0 and not completed.stdout.strip():
            return None
        try:
            value = json.loads(completed.stdout.strip() or "{}")
        except json.JSONDecodeError:
            return None
        points = self._clean_points(value.get("points") or [])
        return None if len(points) < 2 else {"provider": str(value.get("provider") or "external"), "points": points}

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
        dx, dy = end[0] - start[0], end[1] - start[1]
        distance = max(1.0, math.hypot(dx, dy))
        nx, ny = -dy / distance, dx / distance
        bend = min(36.0, max(7.0, distance * 0.07))
        c1 = (start[0] + dx * 0.33 + nx * bend, start[1] + dy * 0.33 + ny * bend)
        c2 = (start[0] + dx * 0.72 + nx * bend * 0.45, start[1] + dy * 0.72 + ny * bend * 0.45)
        points = []
        for index in range(steps + 1):
            t = index / steps
            u = 1.0 - t
            points.append((u**3 * start[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t**3 * end[0], u**3 * start[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t**3 * end[1]))
        return points

    @staticmethod
    def _steps(start: Point, end: Point) -> int:
        return max(18, min(72, int(round(18 + math.hypot(end[0] - start[0], end[1] - start[1]) / 12.0))))

    @staticmethod
    def _clean_points(values: Iterable[Any]) -> List[Point]:
        result = []
        for value in values:
            try:
                point = (float(value["x"]), float(value["y"])) if isinstance(value, dict) else (float(value[0]), float(value[1]))
            except (KeyError, TypeError, ValueError, IndexError):
                continue
            if not result or math.hypot(result[-1][0] - point[0], result[-1][1] - point[1]) > 0.01:
                result.append(point)
        return result
