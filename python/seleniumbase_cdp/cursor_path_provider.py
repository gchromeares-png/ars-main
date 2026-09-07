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

    Every runtime instance owns a private in-memory RNG. Motion is generated
    parametrically per action instead of selecting from a small set of fixed
    profiles. A caller may supply its existing task/profile seed namespace so
    parallel tasks keep independent, reproducible motion streams.
    """

    def __init__(self, *, helper_path: str | Path | None = None, seed: str | int | None = None) -> None:
        self._helper = Path(helper_path).expanduser().resolve() if helper_path else Path(__file__).with_name("cursor_path_helper.cjs")
        self._node = os.environ.get("ARES_NODE_EXECUTABLE", "node").strip() or "node"
        runtime_seed = os.environ.get("ARES_INTERACTION_SEED", "").strip()
        effective_seed: str | int = runtime_seed if runtime_seed else (seed if seed is not None else int.from_bytes(os.urandom(32), "big"))
        self._runtime_seeded = bool(runtime_seed)
        self._rng = random.Random(effective_seed)
        self._movement_index = 0

    def plan(self, start: Point, end: Point, *, preferred: str = "ghost-cursor") -> Dict[str, Any]:
        start = (float(start[0]), float(start[1]))
        end = (float(end[0]), float(end[1]))
        # The external GhostCursor helper owns its own randomness. A task-scoped
        # replay seed therefore uses the existing Python Bezier path so the
        # complete motion stream remains deterministic for that task id.
        external = None if self._runtime_seeded else self._external(start, end, preferred=preferred)
        if external:
            external["points"] = self._sessionize_points(external.get("points") or [], start, end)
            return external
        points = self._sessionize_points(self._python_bezier(start, end), start, end)
        return {"provider": "python-bezier", "points": points}

    def _sessionize_points(self, values: Iterable[Any], start: Point, end: Point) -> List[Point]:
        points = self._clean_points(values)
        if len(points) < 3:
            return points

        self._movement_index += 1
        dx, dy = end[0] - start[0], end[1] - start[1]
        distance = max(1.0, math.hypot(dx, dy))
        nx, ny = -dy / distance, dx / distance
        amplitude = self._rng.uniform(0.35, 1.55)
        phase = self._rng.uniform(-0.55, 0.55)
        secondary_phase = self._rng.uniform(0.0, math.tau)
        result: List[Point] = [start]
        denominator = max(1, len(points) - 1)

        for index, (x, y) in enumerate(points[1:-1], start=1):
            t = index / denominator
            envelope = 4.0 * t * (1.0 - t)
            primary = math.sin(math.pi * t + phase)
            secondary = 0.22 * math.sin(math.tau * t + secondary_phase)
            micro = self._rng.uniform(-0.18, 0.18)
            offset = envelope * (amplitude * (primary + secondary) + micro)
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

    def _motion_parameters(self, *, end_hold_backtrack: bool) -> Dict[str, float]:
        """Generate one bounded, solve-safe motion recipe for a single drag."""
        return {
            "prePress": self._rng.uniform(0.026, 0.064),
            "postPress": self._rng.uniform(0.038, 0.082),
            "baseDelay": self._rng.uniform(0.0075, 0.0135),
            "acceleration": self._rng.uniform(0.004, 0.015),
            "wave": self._rng.uniform(0.0, 0.0045),
            "waveCycles": self._rng.uniform(0.75, 2.15),
            "endHold": self._rng.uniform(0.09, 0.18) if end_hold_backtrack else 0.0,
            "backtrackPx": self._rng.uniform(0.8, 2.2) if end_hold_backtrack else 0.0,
            "backtrackHold": self._rng.uniform(0.038, 0.078) if end_hold_backtrack else 0.0,
        }

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

        motion = self._motion_parameters(end_hold_backtrack=end_hold_backtrack)
        motion_id = f"m{self._movement_index}-{self._rng.getrandbits(48):012x}"
        if self._play_cdp_drag(seleniumbase_cdp, points, motion=motion, end_hold_backtrack=end_hold_backtrack):
            return {
                "moved": True,
                "provider": f"{provider}:cdp",
                "pointCount": len(points),
                "motionId": motion_id,
                "motionParameters": {key: round(value, 6) for key, value in motion.items()},
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
        motion: Dict[str, float],
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
            await asyncio.sleep(motion["prePress"])
            await tab.send(cdp_input.dispatch_mouse_event("mousePressed", x=sx, y=sy, button=button, buttons=1, click_count=1))
            await asyncio.sleep(motion["postPress"])
            ex, ey = points[-1]
            try:
                count = max(1, len(points) - 1)
                for index, (x, y) in enumerate(points[1:], start=1):
                    t = index / count
                    delay = (
                        motion["baseDelay"]
                        + motion["acceleration"] * (t * t)
                        + motion["wave"] * abs(math.sin(math.pi * motion["waveCycles"] * t))
                    )
                    await tab.send(cdp_input.dispatch_mouse_event("mouseMoved", x=x, y=y, button=button, buttons=1))
                    await asyncio.sleep(delay)

                ex, ey = points[-1]
                if end_hold_backtrack:
                    await asyncio.sleep(motion["endHold"])
                    px, py = points[-2]
                    dx, dy = ex - px, ey - py
                    length = max(1e-6, math.hypot(dx, dy))
                    back = motion["backtrackPx"]
                    bx = ex - dx / length * back
                    by = ey - dy / length * back
                    await tab.send(cdp_input.dispatch_mouse_event("mouseMoved", x=bx, y=by, button=button, buttons=1))
                    await asyncio.sleep(motion["backtrackHold"])
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
