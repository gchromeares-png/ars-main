from __future__ import annotations

import json
from typing import Any, Dict

from cursor_path_provider import CursorPathProvider


class SliderActionExecutor:
    """Move a detected slider with one seeded path system and closed-loop correction.

    Grounding owns the desired fraction. This executor owns slider mechanics:
    an end-target may deliberately overshoot to 102%, then the observed slider
    response is used to learn an effective gain and make at most three
    deterministic correction drags. Success is explicit completion or a
    measured residual <= 0.02.
    """

    _TOLERANCE = 0.02
    _MAX_CORRECTIONS = 3
    _END_TARGET_THRESHOLD = 0.90
    _END_OVERSHOOT = 1.02

    def __init__(self, seleniumbase_cdp: Any, slider_adapter: Any, path_provider: CursorPathProvider | None = None) -> None:
        self._sb = seleniumbase_cdp
        self._slider_adapter = slider_adapter
        self._paths = path_provider or CursorPathProvider()
        self._gain_signature = ""
        self._gain = 1.0

    def apply(
        self,
        target_fraction: float = 0.96,
        *,
        state: Dict[str, Any] | None = None,
        force_fallback: bool = False,
    ) -> Dict[str, Any]:
        state = state or self._slider_adapter.poll()
        if state.get("kind") != "slider":
            return {"moved": False, "targetFraction": 0.0, "mode": "none", "state": state}

        target = max(0.0, min(1.0, float(target_fraction)))
        if force_fallback:
            return self._fallback_result(state, target)

        signature = self._mechanics_signature(state)
        if signature != self._gain_signature:
            self._gain_signature = signature
            self._gain = 1.0

        initial_fraction = self._fraction(state)
        end_target = str(state.get("orientation") or "horizontal") != "vertical" and target >= self._END_TARGET_THRESHOLD
        first_command = self._END_OVERSHOOT if end_target else target
        first = self._planned_drag(state, first_command, end_hold_backtrack=end_target)
        if not first.get("moved"):
            return self._fallback_result(state, target)

        latest = self._slider_adapter.poll()
        attempts = 0
        corrections = []
        observed = self._fraction(latest)
        self._learn_gain(initial_fraction, first_command, observed)

        while not self._is_success(latest, target) and attempts < self._MAX_CORRECTIONS:
            if latest.get("kind") != "slider":
                break
            residual = target - observed
            if abs(residual) <= self._TOLERANCE:
                break

            attempts += 1
            gain = self._bounded_gain(self._gain)
            # Dither shrinks with the remaining error. Alternating sign keeps it
            # deterministic while the seeded CursorPathProvider owns the actual
            # motion variation.
            dither = abs(residual) * 0.08 * (1.0 if attempts % 2 else -1.0)
            command = observed + residual / gain + dither
            command = max(-0.02, min(self._END_OVERSHOOT, command))

            before = observed
            correction = self._planned_drag(latest, command, end_hold_backtrack=False)
            if not correction.get("moved"):
                break
            latest = self._slider_adapter.poll()
            observed = self._fraction(latest)
            self._learn_gain(before, command, observed)
            corrections.append({
                "attempt": attempts,
                "commandFraction": round(command, 6),
                "observedFraction": round(observed, 6),
                "residual": round(target - observed, 6),
                "gain": round(self._gain, 6),
                "motionId": correction.get("motionId"),
            })

        success = self._is_success(latest, target)
        mode = f"path:{first.get('provider') or 'unknown'}"
        return {
            "moved": True,
            "targetFraction": target,
            "commandFraction": first_command,
            "mode": mode,
            "pointCount": int(first.get("pointCount") or 0),
            "motionId": first.get("motionId"),
            "motionParameters": first.get("motionParameters") if isinstance(first.get("motionParameters"), dict) else {},
            "endHoldBacktrack": bool(end_target),
            "closedLoop": True,
            "correctionAttempts": attempts,
            "corrections": corrections,
            "learnedGain": round(self._gain, 6),
            "observedFraction": round(self._fraction(latest), 6),
            "residual": round(target - self._fraction(latest), 6),
            "verified": success,
            "state": latest,
        }

    def _fallback_result(self, state: Dict[str, Any], target: float) -> Dict[str, Any]:
        moved = self._native_drag(state, target)
        mode = "seleniumbase-native" if moved else "event-fallback"
        if not moved:
            moved = self._apply_document(target, state)
        latest = self._slider_adapter.poll()
        return {
            "moved": moved,
            "targetFraction": target,
            "mode": mode if moved else "none",
            "pointCount": 2 if moved and mode == "seleniumbase-native" else 0,
            "verified": self._is_success(latest, target),
            "state": latest,
        }

    def _planned_drag(self, state: Dict[str, Any], command: float, *, end_hold_backtrack: bool) -> Dict[str, Any]:
        viewport = self._viewport_points(state, command)
        if viewport is None:
            return {"moved": False, "provider": "none", "pointCount": 0}
        gui = self._screen_points(state, command)
        viewport_start, viewport_end = viewport
        gui_start, gui_end = gui if gui is not None else (None, None)
        try:
            return self._paths.play_drag(
                self._sb,
                viewport_start,
                viewport_end,
                preferred="ghost-cursor",
                gui_start=gui_start,
                gui_end=gui_end,
                end_hold_backtrack=end_hold_backtrack,
            )
        except Exception:
            return {"moved": False, "provider": "none", "pointCount": 0}

    @staticmethod
    def _fraction(state: Dict[str, Any]) -> float:
        try:
            return max(0.0, min(1.0, float(state.get("fraction") or 0.0)))
        except (TypeError, ValueError):
            return 0.0

    @classmethod
    def _is_success(cls, state: Dict[str, Any], target: float) -> bool:
        if bool(state.get("complete")):
            return True
        if state.get("kind") != "slider":
            return False
        return abs(target - cls._fraction(state)) <= cls._TOLERANCE

    def _learn_gain(self, before: float, command: float, observed: float) -> None:
        requested = command - before
        reacted = observed - before
        if abs(requested) < 0.01 or abs(reacted) < 0.002 or requested * reacted <= 0:
            return
        measured = abs(reacted / requested)
        measured = self._bounded_gain(measured)
        self._gain = self._bounded_gain(0.35 * self._gain + 0.65 * measured)

    @staticmethod
    def _bounded_gain(value: float) -> float:
        return max(0.25, min(2.5, float(value)))

    @staticmethod
    def _mechanics_signature(state: Dict[str, Any]) -> str:
        track = state.get("trackRect") if isinstance(state.get("trackRect"), dict) else {}
        handle = state.get("handleRect") if isinstance(state.get("handleRect"), dict) else {}
        return "|".join([
            str(state.get("scope") or ""),
            str(state.get("documentEpoch") or 0),
            str(state.get("sessionGeneration") or 0),
            str(state.get("orientation") or "horizontal"),
            str(bool(state.get("nativeRange"))),
            str(state.get("trackSelector") or ""),
            str(state.get("handleSelector") or ""),
            str(round(float(track.get("width") or 0.0), 2)),
            str(round(float(track.get("height") or 0.0), 2)),
            str(round(float(handle.get("width") or 0.0), 2)),
            str(round(float(handle.get("height") or 0.0), 2)),
        ])

    @staticmethod
    def _viewport_points(state: Dict[str, Any], target: float):
        track = state.get("trackRect") if isinstance(state.get("trackRect"), dict) else None
        handle = state.get("handleRect") if isinstance(state.get("handleRect"), dict) else None
        if not track or not handle:
            return None
        try:
            tx = float(track.get("x") or 0.0)
            ty = float(track.get("y") or 0.0)
            width = float(track.get("width") or 0.0)
            height = float(track.get("height") or 0.0)
            hx = float(handle.get("x") or 0.0)
            hy = float(handle.get("y") or 0.0)
            hw = float(handle.get("width") or 0.0)
            hh = float(handle.get("height") or 0.0)
            current = SliderActionExecutor._fraction(state)
        except (TypeError, ValueError):
            return None
        if width <= 0 or height <= 0:
            return None

        native = bool(state.get("nativeRange"))
        if state.get("orientation") == "vertical":
            start = (tx + width / 2.0 if native else hx + hw / 2.0, ty + height - height * current if native else hy + hh / 2.0)
            # Custom sliders use the full track as the command coordinate. The
            # observed response, not handle width assumptions, closes the loop.
            end = (tx + width / 2.0, ty + height - height * max(0.0, min(1.0, target)) if native else ty + height * (1.0 - target))
        else:
            start = (tx + width * current if native else hx + hw / 2.0, ty + height / 2.0 if native else hy + hh / 2.0)
            end = (tx + width * max(0.0, min(1.0, target)) if native else tx + width * target, ty + height / 2.0)
        return start, end

    def _screen_points(self, state: Dict[str, Any], target: float):
        handle_selector = str(state.get("handleSelector") or "")
        track_selector = str(state.get("trackSelector") or "")
        rect = state.get("trackRect") if isinstance(state.get("trackRect"), dict) else {}
        if not handle_selector or not track_selector or not rect:
            return None
        try:
            handle_x, handle_y = self._sb.get_gui_element_center(handle_selector)
            track_x, track_y = self._sb.get_gui_element_center(track_selector)
            width = float(rect.get("width") or 0)
            height = float(rect.get("height") or 0)
            current = self._fraction(state)
            if width <= 0 or height <= 0:
                return None
            native = bool(state.get("nativeRange"))
            if state.get("orientation") == "vertical":
                start_x = float(handle_x)
                start_y = float(track_y) + height / 2 - height * current if native else float(handle_y)
                end_x = float(track_x)
                end_y = float(track_y) + height / 2 - height * max(0.0, min(1.0, target)) if native else float(track_y) + height / 2 - height * target
            else:
                start_x = float(track_x) - width / 2 + width * current if native else float(handle_x)
                start_y = float(handle_y)
                end_x = float(track_x) - width / 2 + width * (max(0.0, min(1.0, target)) if native else target)
                end_y = float(track_y)
            return (start_x, start_y), (end_x, end_y)
        except Exception:
            return None

    def _native_drag(self, state: Dict[str, Any], target: float) -> bool:
        points = self._screen_points(state, target)
        if points is None:
            return False
        start, end = points
        try:
            self._sb.gui_drag_drop_points(int(round(start[0])), int(round(start[1])), int(round(end[0])), int(round(end[1])), timeframe=0.55)
            return True
        except Exception:
            return False

    def _apply_document(self, target: float, state: Dict[str, Any]) -> bool:
        overrides = getattr(self._slider_adapter, "_overrides", {})
        script = f"""
        (() => {{
          const target = {json.dumps(target)};
          const overrides = {json.dumps(overrides)};
          const visible = el => {{
            if (!el?.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width >= 18 && r.height >= 12 && s.display !== 'none' && s.visibility !== 'hidden';
          }};
          const roots = [], seen = new Set();
          const walk = root => {{
            if (!root || seen.has(root)) return;
            seen.add(root); roots.push(root);
            for (const el of root.querySelectorAll?.('*') || []) if (el.shadowRoot) walk(el.shadowRoot);
            for (const frame of root.querySelectorAll?.('iframe') || []) {{ try {{ if (frame.contentDocument) walk(frame.contentDocument); }} catch (_) {{}} }}
          }};
          walk(document);
          for (const root of roots) {{
            const scopedRoot = overrides.sliderRoot ? root.querySelector(overrides.sliderRoot) || root : root;
            let handles = overrides.sliderHandle ? [...scopedRoot.querySelectorAll(overrides.sliderHandle)].filter(visible) : [];
            if (!handles.length) handles = [...scopedRoot.querySelectorAll('input[type="range"],[role="slider"],[aria-valuenow]')].filter(visible);
            if (!handles.length) handles = [...scopedRoot.querySelectorAll('[class*="slider" i] [class*="thumb" i],[class*="slider" i] [class*="handle" i],[class*="drag" i] [class*="handle" i]')].filter(visible);
            for (const handle of handles) {{
              const nativeRange = handle.matches('input[type="range"]');
              let track = overrides.sliderTrack ? scopedRoot.querySelector(overrides.sliderTrack) : null;
              if (!track && nativeRange) track = handle;
              if (!track) track = handle.closest('[role="slider"]')?.parentElement || handle.closest('[class*="slider" i],[class*="track" i],[class*="drag" i]') || handle.parentElement;
              if (!track || !visible(track)) continue;
              if (nativeRange) {{
                const min = Number(handle.min || 0), max = Number(handle.max || 100);
                handle.value = String(min + (max - min) * target);
                handle.dispatchEvent(new Event('input', {{bubbles:true}}));
                handle.dispatchEvent(new Event('change', {{bubbles:true}}));
                return true;
              }}
              const r = track.getBoundingClientRect(), h = handle.getBoundingClientRect();
              const horizontal = r.width >= r.height;
              const x = horizontal ? r.left + r.width * target : r.left + r.width / 2;
              const y = horizontal ? r.top + r.height / 2 : r.top + r.height * (1 - target);
              const sx = h.left + h.width / 2, sy = h.top + h.height / 2;
              const opts = {{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true}};
              handle.dispatchEvent(new PointerEvent('pointerdown', {{...opts,clientX:sx,clientY:sy,buttons:1}}));
              handle.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true,cancelable:true,clientX:sx,clientY:sy,buttons:1}}));
              document.dispatchEvent(new PointerEvent('pointermove', {{...opts,clientX:x,clientY:y,buttons:1}}));
              document.dispatchEvent(new MouseEvent('mousemove', {{bubbles:true,cancelable:true,clientX:x,clientY:y,buttons:1}}));
              document.dispatchEvent(new PointerEvent('pointerup', {{...opts,clientX:x,clientY:y,buttons:0}}));
              document.dispatchEvent(new MouseEvent('mouseup', {{bubbles:true,cancelable:true,clientX:x,clientY:y,buttons:0}}));
              return true;
            }}
          }}
          return false;
        }})()
        """
        frame_path = [str(value) for value in state.get("framePath") or [] if str(value)]
        if frame_path:
            oopif_evaluate = getattr(self._sb, "ares_oopif_evaluate", None)
            if callable(oopif_evaluate):
                try:
                    evaluated = oopif_evaluate(frame_path, f"return {script};", [])
                    return bool(evaluated.get("value")) if isinstance(evaluated, dict) else bool(evaluated)
                except Exception:
                    return False
        try:
            return bool(self._evaluate(script))
        except Exception:
            return False

    def _evaluate(self, script: str) -> Any:
        evaluator = getattr(self._sb, "evaluate", None)
        if callable(evaluator):
            return evaluator(script)
        return self._sb.execute_script(f"return {script};")
