from __future__ import annotations

import hashlib
import json
from typing import Any, Dict

from stable_marks import build_stable_marks, stable_mark_digest


class SliderSiteAdapter:
    """Domain-agnostic structural detector for slider-style test interactions."""

    def __init__(self, seleniumbase_cdp: Any, *, overrides: Dict[str, str] | None = None) -> None:
        self._sb = seleniumbase_cdp
        self._overrides = self._clean_overrides(overrides or {})
        self._generation = 0
        self._last_signature = ""

    def poll(self) -> Dict[str, Any]:
        primary = self._snapshot_document()
        oopif = self._snapshot_oopif_frames()
        if bool(primary.get("complete")) or bool(primary.get("failed")):
            snapshot = primary
        elif bool(oopif.get("complete")) or bool(oopif.get("failed")):
            snapshot = oopif
        elif oopif.get("kind") == "slider" and (
            primary.get("kind") != "slider" or int(oopif.get("score") or 0) > int(primary.get("score") or 0)
        ):
            snapshot = oopif
        else:
            snapshot = primary
        return self._with_generation(snapshot)

    def _slider_expression(self) -> str:
        overrides = json.dumps(self._overrides)
        return f"""
        (() => {{
          const overrides = {overrides};
          const viewport = {{
            width: window.innerWidth || document.documentElement.clientWidth || 0,
            height: window.innerHeight || document.documentElement.clientHeight || 0,
            scrollX: window.scrollX || 0,
            scrollY: window.scrollY || 0,
            devicePixelRatio: window.devicePixelRatio || 1,
          }};
          const visible = el => {{
            if (!el?.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width >= 10 && r.height >= 8 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
          }};
          const text = el => (el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').trim().replace(/\\s+/g, ' ');
          const rectOf = (el, offset={{x:0,y:0}}) => {{
            const r = el.getBoundingClientRect();
            return {{x:r.x + (offset?.x || 0),y:r.y + (offset?.y || 0),width:r.width,height:r.height}};
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
          const scopeToken = (el, fallbackIndex=0) => {{
            if (!el) return `slot:${{fallbackIndex}}`;
            const id = el.getAttribute?.('id') || '';
            const testId = el.getAttribute?.('data-testid') || '';
            const name = el.getAttribute?.('name') || '';
            const aria = el.getAttribute?.('aria-label') || '';
            const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0,3).join('.') : '';
            const tag = (el.tagName || 'node').toLowerCase();
            return [tag,id,testId,name,aria,cls,`slot:${{fallbackIndex}}`].join('|');
          }};
          const structuralKey = (el, role, fallbackIndex=0) => {{
            if (!el) return `${{role}}:slot:${{fallbackIndex}}`;
            const selector = selectorFor(el);
            if (selector) return selector;
            const id = el.getAttribute?.('id') || '';
            const testId = el.getAttribute?.('data-testid') || '';
            const name = el.getAttribute?.('name') || '';
            const aria = el.getAttribute?.('aria-label') || '';
            const roleAttr = el.getAttribute?.('role') || '';
            const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0,4).join('.') : '';
            return [role, el.tagName || '', id, testId, name, aria, roleAttr, cls, `slot:${{fallbackIndex}}`].join('|');
          }};
          const semanticSignature = (el, role) => {{
            if (!el) return role;
            const style = getComputedStyle(el);
            return [
              role,
              text(el).slice(0,240),
              el.getAttribute?.('aria-valuenow') || '',
              el.getAttribute?.('aria-valuetext') || '',
              el.getAttribute?.('data-target') || '',
              el.getAttribute?.('data-goal') || '',
              style.backgroundColor || '',
              style.borderColor || '',
            ].join('|');
          }};
          const numberValue = (...values) => {{
            for (const raw of values) {{
              if (raw === null || raw === undefined || String(raw).trim() === '') continue;
              const parsed = Number(raw);
              if (Number.isFinite(parsed)) return parsed;
            }}
            return null;
          }};
          const roots = [], seen = new Set();
          const walk = (root, scope, offset={{x:0,y:0}}) => {{
            if (!root || seen.has(root)) return;
            seen.add(root); roots.push([root, scope, offset]);
            const all = [...(root.querySelectorAll?.('*') || [])];
            for (const [index,el] of all.entries()) {{
              if (el.shadowRoot) walk(el.shadowRoot, scope + '/shadow:' + scopeToken(el,index), offset);
            }}
            const frames = [...(root.querySelectorAll?.('iframe') || [])];
            for (const [index,frame] of frames.entries()) {{
              try {{
                if (frame.contentDocument) {{
                  const r = frame.getBoundingClientRect();
                  walk(
                    frame.contentDocument,
                    scope + '/iframe:' + scopeToken(frame,index),
                    {{x:(offset?.x || 0) + r.left + Number(frame.clientLeft || 0), y:(offset?.y || 0) + r.top + Number(frame.clientTop || 0)}}
                  );
                }}
              }} catch (_) {{}}
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
          let explicitComplete = false;
          let explicitFailed = false;
          for (const [root, scope, offset] of roots) {{
            const scopedRoot = overrides.sliderRoot ? root.querySelector(overrides.sliderRoot) || root : root;
            let handles = [];
            if (overrides.sliderHandle) handles = [...scopedRoot.querySelectorAll(overrides.sliderHandle)].filter(visible);
            if (!handles.length) handles = [...scopedRoot.querySelectorAll('input[type="range"],[role="slider"],[aria-valuenow]')].filter(visible);
            if (!handles.length) handles = [...scopedRoot.querySelectorAll('[class*="slider" i] [class*="thumb" i],[class*="slider" i] [class*="handle" i],[class*="drag" i] [class*="handle" i],.sliderContainer > .slider,.sliderContainer .sliderIcon')].filter(visible);

            const complete = Boolean(overrides.sliderComplete && scopedRoot.querySelector(overrides.sliderComplete));
            const failed = Boolean(overrides.sliderFailed && scopedRoot.querySelector(overrides.sliderFailed));
            explicitComplete = explicitComplete || complete;
            explicitFailed = explicitFailed || failed;

            for (const handle of handles) {{
              const nativeRange = handle.matches('input[type="range"]');
              let track = overrides.sliderTrack ? scopedRoot.querySelector(overrides.sliderTrack) : null;
              if (!track && nativeRange) track = handle;
              if (!track && scopedRoot.querySelector?.('.sliderContainer .sliderbg')) track = scopedRoot.querySelector('.sliderContainer .sliderbg');
              if (!track) track = handle.closest('[role="slider"]')?.parentElement || handle.closest('[class*="slider" i],[class*="track" i],[class*="drag" i]') || handle.parentElement;
              if (!track || !visible(track)) continue;

              const h = handle.getBoundingClientRect(), t = track.getBoundingClientRect();
              const horizontal = t.width >= t.height;
              const min = nativeRange
                ? (numberValue(handle.min, handle.getAttribute('min'), 0) ?? 0)
                : (numberValue(handle.getAttribute('aria-valuemin'), handle.min, 0) ?? 0);
              const max = nativeRange
                ? (numberValue(handle.max, handle.getAttribute('max'), 100) ?? 100)
                : (numberValue(handle.getAttribute('aria-valuemax'), handle.max, 100) ?? 100);
              const value = nativeRange
                ? (numberValue(handle.value, handle.getAttribute('value'), min) ?? min)
                : (numberValue(handle.getAttribute('aria-valuenow'), handle.value, min) ?? min);
              const span = Math.max(1, max - min);
              const fraction = Math.max(0, Math.min(1, (value - min) / span));
              const instruction = overrides.sliderInstruction
                ? scopedRoot.querySelector(overrides.sliderInstruction)
                : scopedRoot.querySelector?.('.sliderText') || track.parentElement?.previousElementSibling || track.parentElement;

              const targetSelector = overrides.sliderTarget || '.sliderContainer .sliderTarget,.sliderContainer .sliderTargetIcon,[data-target],[data-goal],[aria-label*="target" i],[aria-label*="goal" i],[class*="target" i],[class*="goal" i],[class*="marker" i],[class*="tick" i]';
              const targetNodes = [...(scopedRoot.querySelectorAll?.(targetSelector) || [])]
                .filter(el => el !== handle && el !== track && visible(el));
              const rawTargets = [];
              for (const [targetIndex,node] of targetNodes.entries()) {{
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
                rawTargets.push({{
                  role:'slider-target',
                  fraction:Math.max(0,Math.min(1,targetFraction)),
                  score:targetScore,
                  confidence:Math.max(0.5,Math.min(0.96,0.45 + targetScore/180)),
                  label:label.slice(0,160),
                  visualBounds:rectOf(node, offset),
                  selector:selectorFor(node),
                  structuralKey:structuralKey(node,'slider-target',targetIndex),
                  semanticSignature:semanticSignature(node,'slider-target'),
                }});
              }}
              rawTargets.sort((a,b) => b.score-a.score);

              const rawMarks = [
                {{
                  role:'slider-handle', visualBounds:rectOf(handle, offset), confidence:0.98,
                  selector:overrides.sliderHandle || selectorFor(handle),
                  structuralKey:structuralKey(handle,'slider-handle',0),
                  semanticSignature:semanticSignature(handle,'slider-handle'),
                }},
                {{
                  role:'slider-track', visualBounds:rectOf(track, offset), confidence:0.96,
                  selector:overrides.sliderTrack || selectorFor(track),
                  structuralKey:structuralKey(track,'slider-track',0),
                  semanticSignature:semanticSignature(track,'slider-track'),
                }},
                ...rawTargets,
              ];

              let score = 45;
              if (handle.matches('input[type="range"],[role="slider"]')) score += 25;
              if (overrides.sliderHandle || overrides.sliderTrack) score += 20;
              if (handle.matches?.('.slider,.sliderIcon')) score += 20;
              if (t.width >= 120 || t.height >= 120) score += 10;
              if (text(instruction)) score += 5;
              if (rawTargets.length) score += 8;
              candidates.push({{
                kind:'slider', scope, score,
                orientation: horizontal ? 'horizontal' : 'vertical',
                fraction, min, max, value,
                instruction:text(instruction).slice(0,600),
                handleRect:rectOf(handle, offset),
                trackRect:rectOf(track, offset),
                handleSelector: overrides.sliderHandle || selectorFor(handle),
                trackSelector: overrides.sliderTrack || selectorFor(track),
                nativeRange,
                rawMarks,
                viewport,
                complete,
                failed,
                override:Boolean(overrides.sliderRoot || overrides.sliderHandle || overrides.sliderTrack || overrides.sliderTarget)
              }});
            }}
          }}
          candidates.sort((a,b) => b.score-a.score);
          return candidates[0] || {{kind:'none',scope:'document',score:0,orientation:'horizontal',fraction:0,min:0,max:0,value:0,instruction:'',handleRect:null,trackRect:null,handleSelector:'',trackSelector:'',nativeRange:false,rawMarks:[],viewport,complete:explicitComplete,failed:explicitFailed,override:false}};
        }})()
        """

    def _snapshot_document(self) -> Dict[str, Any]: