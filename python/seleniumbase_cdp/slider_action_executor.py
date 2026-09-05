from __future__ import annotations

import json
from typing import Any, Dict


class SliderActionExecutor:
    """Move the currently detected slider to a relative target position."""

    def __init__(self, seleniumbase_cdp: Any, slider_adapter: Any) -> None:
        self._sb = seleniumbase_cdp
        self._slider_adapter = slider_adapter

    def apply(self, target_fraction: float = 0.96) -> Dict[str, Any]:
        state = self._slider_adapter.poll()
        if state.get("kind") != "slider":
            return {"moved": False, "targetFraction": 0.0, "mode": "none", "state": state}

        target = max(0.0, min(1.0, float(target_fraction)))
        moved = self._native_drag(state, target)
        mode = "seleniumbase-native" if moved else "event-fallback"
        if not moved:
            moved = self._apply_document(target)
        return {"moved": moved, "targetFraction": target, "mode": mode if moved else "none", "state": self._slider_adapter.poll()}

    def _native_drag(self, state: Dict[str, Any], target: float) -> bool:
        handle_selector = str(state.get("handleSelector") or "")
        track_selector = str(state.get("trackSelector") or "")
        rect = state.get("trackRect") if isinstance(state.get("trackRect"), dict) else {}
        if not handle_selector or not track_selector or not rect:
            return False
        try:
            handle_x, handle_y = self._sb.get_gui_element_center(handle_selector)
            track_x, track_y = self._sb.get_gui_element_center(track_selector)
            width = float(rect.get("width") or 0)
            height = float(rect.get("height") or 0)
            current = max(0.0, min(1.0, float(state.get("fraction") or 0)))
            if state.get("orientation") == "vertical":
                start_x = float(handle_x)
                start_y = float(track_y) + height / 2 - height * current if state.get("nativeRange") else float(handle_y)
                end_x = float(track_x)
                end_y = float(track_y) + height / 2 - height * target
            else:
                start_x = float(track_x) - width / 2 + width * current if state.get("nativeRange") else float(handle_x)
                start_y = float(handle_y)
                end_x = float(track_x) - width / 2 + width * target
                end_y = float(track_y)
            self._sb.gui_drag_drop_points(
                int(round(start_x)), int(round(start_y)),
                int(round(end_x)), int(round(end_y)),
                timeframe=0.55,
            )
            return True
        except Exception:
            return False

    def _apply_document(self, target: float) -> bool:
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
            for (const frame of root.querySelectorAll?.('iframe') || []) {{
              try {{ if (frame.contentDocument) walk(frame.contentDocument); }} catch (_) {{}}
            }}
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

              const r = track.getBoundingClientRect();
              const horizontal = r.width >= r.height;
              const x = horizontal ? r.left + r.width * target : r.left + r.width / 2;
              const y = horizontal ? r.top + r.height / 2 : r.bottom - r.height * target;
              const h = handle.getBoundingClientRect();
              const sx = h.left + h.width / 2, sy = h.top + h.height / 2;
              const opts = {{bubbles:true, cancelable:true, pointerId:1, pointerType:'mouse', isPrimary:true}};
              handle.dispatchEvent(new PointerEvent('pointerdown', {{...opts, clientX:sx, clientY:sy, buttons:1}}));
              handle.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true, cancelable:true, clientX:sx, clientY:sy, buttons:1}}));
              document.dispatchEvent(new PointerEvent('pointermove', {{...opts, clientX:x, clientY:y, buttons:1}}));
              document.dispatchEvent(new MouseEvent('mousemove', {{bubbles:true, cancelable:true, clientX:x, clientY:y, buttons:1}}));
              document.dispatchEvent(new PointerEvent('pointerup', {{...opts, clientX:x, clientY:y, buttons:0}}));
              document.dispatchEvent(new MouseEvent('mouseup', {{bubbles:true, cancelable:true, clientX:x, clientY:y, buttons:0}}));
              return true;
            }}
          }}
          return false;
        }})()
        """
        try:
            return bool(self._evaluate(script))
        except Exception:
            return False

    def _evaluate(self, script: str) -> Any:
        evaluator = getattr(self._sb, "evaluate", None)
        if callable(evaluator):
            return evaluator(script)
        return self._sb.execute_script(f"return {script};")
