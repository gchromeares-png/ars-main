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
            return r.width >= 10 && r.height >= 8 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
          }};
          const text = el => (el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').trim().replace(/\\s+/g, ' ');
          const rectOf = el => {{
            const r = el.getBoundingClientRect();
            return {{x:r.x,y:r.y,width:r.width,height:r.height}};
          }};
          const selectorFor = el => {{
            if (!el || el.getRootNode?.() !== document) return '';
            if (el.id) return '#' + CSS.escape(el.id);
            const testId = el.getAttribute?.('data-testid');
            if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
            if (el.matches?.('input[type="range"]')) {{
              const name = el.getAttribute('name');
              return name ? 'input[type="range"][name="' + CSS.escape(name) + '"]' : 'input[type="range"]';
            }}
            return '';
          }};
          const roots = [], seen = new Set();
          const walk = (root, scope) => {{
            if (!root || seen.has(root)) return;
            seen.add(root); roots.push([root, scope]);
            for (const el of root.querySelectorAll?.('*') || []) if (el.shadowRoot) walk(el.shadowRoot, scope + '/shadow');
            for (const frame of root.querySelectorAll?.('iframe') || []) {{
              try {{ if (frame.contentDocument) walk(frame.contentDocument, scope + '/iframe'); }} catch (_) {{}}
            }}
          }};
          const center = r => [r.x + r.width/2, r.y + r.height/2];
          const distanceToRect = (x,y,r) => {{
            const dx = Math.max(r.x-x, 0, x-(r.x+r.width));
            const dy = Math.max(r.y-y, 0, y-(r.y+r.height));
            return Math.hypot(dx,dy);
          }};
          walk(document, 'document');

          const candidates = [];
          for (const [root, scope] of roots) {{
            const scopedRoot = overrides.sliderRoot ? root.querySelector(overrides.sliderRoot) || root : root;
            let handles = [];
            if (overrides.sliderHandle) handles = [...scopedRoot.querySelectorAll(overrides.sliderHandle)].filter(visible);
            if (!handles.length) handles = [...scopedRoot.querySelectorAll('input[type="range"],[role="slider"],[aria-valuenow]')].filter(visible);
            if (!handles.length) handles = [...scopedRoot.querySelectorAll('[class*="slider" i] [class*="thumb" i],[class*="slider" i] [class*="handle" i],[class*="drag" i] [class*="handle" i]')].filter(visible);

            for (const handle of handles) {{
              const nativeRange = handle.matches('input[type="range"]');
              let track = overrides.sliderTrack ? scopedRoot.querySelector(overrides.sliderTrack) : null;
              if (!track && nativeRange) track = handle;
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
                ? scopedRoot.querySelector(overrides.sliderInstruction)
                : track.parentElement?.previousElementSibling || track.parentElement;

              const targetSelector = overrides.sliderTarget || '[data-target],[data-goal],[aria-label*="target" i],[aria-label*="goal" i],[class*="target" i],[class*="goal" i],[class*="marker" i],[class*="tick" i]';
              const targetNodes = [...(scopedRoot.querySelectorAll?.(targetSelector) || [])]
                .filter(el => el !== handle && el !== track && visible(el));
              const targetCandidates = [];
              for (const node of targetNodes) {{
                const r = node.getBoundingClientRect();
                const [cx,cy] = center(r);
                const distance = distanceToRect(cx,cy,t);
                const nearLimit = Math.max(36, horizontal ? t.height*4 : t.width*4);
                if (distance > nearLimit) continue;
                const targetFraction = horizontal
                  ? (cx - t.left) / Math.max(1,t.width)
                  : (t.bottom - cy) / Math.max(1,t.height);
                if (targetFraction < -0.12 || targetFraction > 1.12) continue;
                const label = text(node);
                const identity = `${{node.id || ''}} ${{node.className || ''}} ${{node.getAttribute?.('aria-label') || ''}}`;
                let targetScore = 50;
                if (/target|goal|ziel|marker|tick/i.test(identity)) targetScore += 20;
                if (overrides.sliderTarget) targetScore += 25;
                if (label) targetScore += 5;
                if (distance <= 4) targetScore += 10;
                targetCandidates.push({{
                  markId:'',
                  fraction:Math.max(0,Math.min(1,targetFraction)),
                  score:targetScore,
                  label:label.slice(0,160),
                  rect:rectOf(node),
                  selector:selectorFor(node),
                }});
              }}
              targetCandidates.sort((a,b) => b.score-a.score);
              targetCandidates.forEach((item,index) => item.markId = `S${{index+3}}`);

              const marks = [
                {{markId:'S1', role:'slider-handle', rect:rectOf(handle), selector:overrides.sliderHandle || selectorFor(handle)}},
                {{markId:'S2', role:'slider-track', rect:rectOf(track), selector:overrides.sliderTrack || selectorFor(track)}},
                ...targetCandidates.map(item => ({{markId:item.markId, role:'slider-target', rect:item.rect, selector:item.selector, label:item.label}})),
              ];
              const complete = Boolean(overrides.sliderComplete && scopedRoot.querySelector(overrides.sliderComplete));
              const failed = Boolean(overrides.sliderFailed && scopedRoot.querySelector(overrides.sliderFailed));

              let score = 45;
              if (handle.matches('input[type="range"],[role="slider"]')) score += 25;
              if (overrides.sliderHandle || overrides.sliderTrack) score += 20;
              if (t.width >= 120 || t.height >= 120) score += 10;
              if (text(instruction)) score += 5;
              if (targetCandidates.length) score += 8;
              candidates.push({{
                kind:'slider', scope, score,
                orientation: horizontal ? 'horizontal' : 'vertical',
                fraction, min, max, value,
                instruction:text(instruction).slice(0,600),
                handleRect:rectOf(handle),
                trackRect:rectOf(track),
                handleSelector: overrides.sliderHandle || selectorFor(handle),
                trackSelector: overrides.sliderTrack || selectorFor(track),
                nativeRange,
                targetCandidates,
                marks,
                complete,
                failed,
                override:Boolean(overrides.sliderRoot || overrides.sliderHandle || overrides.sliderTrack || overrides.sliderTarget)
              }});
            }}
          }}
          candidates.sort((a,b) => b.score-a.score);
          return candidates[0] || {{kind:'none',scope:'document',score:0,orientation:'horizontal',fraction:0,min:0,max:0,value:0,instruction:'',handleRect:null,trackRect:null,handleSelector:'',trackSelector:'',nativeRange:false,targetCandidates:[],marks:[],complete:false,failed:false,override:false}};
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
            json.dumps(snapshot.get("targetCandidates") or [], sort_keys=True),
            str(bool(snapshot.get("complete"))),
            str(bool(snapshot.get("failed"))),
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
        allowed = {"sliderRoot", "sliderHandle", "sliderTrack", "sliderTarget", "sliderInstruction", "sliderComplete", "sliderFailed"}
        return {key: str(value).strip() for key, value in values.items() if key in allowed and str(value).strip()}

    @staticmethod
    def _normalize(value: Any) -> Dict[str, Any]:
        if not isinstance(value, dict):
            return SliderSiteAdapter._empty()
        target_candidates = [dict(item) for item in value.get("targetCandidates") or [] if isinstance(item, dict)]
        marks = [dict(item) for item in value.get("marks") or [] if isinstance(item, dict)]
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
            "handleSelector": str(value.get("handleSelector") or ""),
            "trackSelector": str(value.get("trackSelector") or ""),
            "nativeRange": bool(value.get("nativeRange")),
            "targetCandidates": target_candidates,
            "marks": marks,
            "complete": bool(value.get("complete")),
            "failed": bool(value.get("failed")),
            "override": bool(value.get("override")),
        }

    @staticmethod
    def _empty() -> Dict[str, Any]:
        return {"kind":"none","scope":"document","score":0,"orientation":"horizontal","fraction":0.0,"min":0.0,"max":0.0,"value":0.0,"instruction":"","handleRect":None,"trackRect":None,"handleSelector":"","trackSelector":"","nativeRange":False,"targetCandidates":[],"marks":[],"complete":False,"failed":False,"override":False}
