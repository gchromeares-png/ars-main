from __future__ import annotations

import hashlib
import json
from typing import Any, Dict


class SliderSiteAdapter:
    """Domain-agnostic structural detector for slider-style test interactions."""

    def __init__(self, seleniumbase_cdp: Any, *, overrides: Dict[str, str] | None = None) -> None:
        self._sb = seleniumbase_cdp
        self._overrides = self._clean_overrides(overrides or {})
        self._generation = 0
        self._last_signature = ""

    def poll(self) -> Dict[str, Any]:
        snapshot = self._snapshot_document()
        return self._with_generation(snapshot)

    def _snapshot_document(self) -> Dict[str, Any]:
        overrides = json.dumps(self._overrides)
        script = f"""
        (() => {{
          const overrides = {overrides};
          const visible = el => {{
            if (!el?.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width >= 18 && r.height >= 12 && s.display !== 'none' && s.visibility !== 'hidden';
          }};
          const text = el => (el?.innerText || el?.textContent || '').trim().replace(/\\s+/g, ' ');
          const roots = [], seen = new Set();
          const walk = (root, scope) => {{
            if (!root || seen.has(root)) return;
            seen.add(root); roots.push([root, scope]);
            for (const el of root.querySelectorAll?.('*') || []) if (el.shadowRoot) walk(el.shadowRoot, scope + '/shadow');
            for (const frame of root.querySelectorAll?.('iframe') || []) {{
              try {{ if (frame.contentDocument) walk(frame.contentDocument, scope + '/iframe'); }} catch (_) {{}}
            }}
          }};
          walk(document, 'document');

          const candidates = [];
          for (const [root, scope] of roots) {{
            let handles = [];
            if (overrides.sliderHandle) handles = [...root.querySelectorAll(overrides.sliderHandle)].filter(visible);
            if (!handles.length) handles = [...root.querySelectorAll('input[type="range"],[role="slider"],[aria-valuenow]')].filter(visible);
            if (!handles.length) {{
              handles = [...root.querySelectorAll('[class*="slider" i] [class*="thumb" i],[class*="slider" i] [class*="handle" i],[class*="drag" i] [class*="handle" i]')].filter(visible);
            }}

            for (const handle of handles) {{
              let track = overrides.sliderTrack ? root.querySelector(overrides.sliderTrack) : null;
              if (!track) track = handle.closest('[role="slider"]')?.parentElement || handle.closest('[class*="slider" i],[class*="track" i],[class*="drag" i]') || handle.parentElement;
              if (!track || !visible(track)) continue;
              const h = handle.getBoundingClientRect(), t = track.getBoundingClientRect();
              const horizontal = t.width >= t.height;
              const min = Number(handle.min ?? handle.getAttribute('aria-valuemin') ?? 0);
              const max = Number(handle.max ?? handle.getAttribute('aria-valuemax') ?? 100);
              const value = Number(handle.value ?? handle.getAttribute('aria-valuenow') ?? min);
              const span = Math.max(1, max - min);
              const fraction = Math.max(0, Math.min(1, (value - min) / span));
              const instruction = overrides.sliderInstruction
                ? root.querySelector(overrides.sliderInstruction)
                : track.parentElement?.previousElementSibling || track.parentElement;
              let score = 45;
              if (handle.matches('input[type="range"],[role="slider"]')) score += 25;
              if (overrides.sliderHandle || overrides.sliderTrack) score += 20;
              if (t.width >= 120 || t.height >= 120) score += 10;
              if (text(instruction)) score += 5;
              candidates.push({{
                kind:'slider', scope, score,
                orientation: horizontal ? 'horizontal' : 'vertical',
                fraction, min, max, value,
                instruction:text(instruction).slice(0,600),
                handleRect:{{x:h.x,y:h.y,width:h.width,height:h.height}},
                trackRect:{{x:t.x,y:t.y,width:t.width,height:t.height}},
                override:Boolean(overrides.sliderHandle || overrides.sliderTrack)
              }});
            }}
          }}
          candidates.sort((a,b) => b.score-a.score);
          return candidates[0] || {{kind:'none',scope:'document',score:0,orientation:'horizontal',fraction:0,min:0,max:0,value:0,instruction:'',handleRect:null,trackRect:null,override:false}};
        }})()
        """
        try:
            value = self._evaluate(script)
        except Exception:
            return self._empty()
        return self._normalize(value)

    def _with_generation(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        signature_input = "|".join([
            str(snapshot.get("kind") or "none"),
            str(snapshot.get("scope") or ""),
            str(snapshot.get("orientation") or ""),
            str(round(float(snapshot.get("fraction") or 0), 4)),
            str(snapshot.get("instruction") or ""),
            json.dumps(snapshot.get("trackRect"), sort_keys=True),
        ])
        signature = hashlib.sha256(signature_input.encode("utf-8", errors="ignore")).hexdigest()
        if signature != self._last_signature:
            self._generation += 1
            self._last_signature = signature
        return {**snapshot, "generation": self._generation, "signature": signature}

    def _evaluate(self, script: str) -> Any:
        evaluator = getattr(self._sb, "evaluate", None)
        if callable(evaluator):
            return evaluator(script)
        return self._sb.execute_script(f"return {script};")

    @staticmethod
    def _clean_overrides(values: Dict[str, str]) -> Dict[str, str]:
        allowed = {"sliderRoot", "sliderHandle", "sliderTrack", "sliderInstruction", "sliderComplete", "sliderFailed"}
        return {key: str(value).strip() for key, value in values.items() if key in allowed and str(value).strip()}

    @staticmethod
    def _normalize(value: Any) -> Dict[str, Any]:
        if not isinstance(value, dict):
            return SliderSiteAdapter._empty()
        return {
            "kind": str(value.get("kind") or "none"),
            "scope": str(value.get("scope") or "document"),
            "score": int(value.get("score") or 0),
            "orientation": str(value.get("orientation") or "horizontal"),
            "fraction": float(value.get("fraction") or 0),
            "min": float(value.get("min") or 0),
            "max": float(value.get("max") or 0),
            "value": float(value.get("value") or 0),
            "instruction": str(value.get("instruction") or ""),
            "handleRect": value.get("handleRect"),
            "trackRect": value.get("trackRect"),
            "override": bool(value.get("override")),
        }

    @staticmethod
    def _empty() -> Dict[str, Any]:
        return {"kind": "none", "scope": "document", "score": 0, "orientation": "horizontal", "fraction": 0.0, "min": 0.0, "max": 0.0, "value": 0.0, "instruction": "", "handleRect": None, "trackRect": None, "override": False}
