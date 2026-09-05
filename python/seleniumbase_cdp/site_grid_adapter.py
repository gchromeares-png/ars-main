from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List


_GRID_SIZES = {9: (3, 3), 16: (4, 4)}
_GRID_SIZES.update({4: (2, 2), 6: (2, 3), 8: (2, 4), 12: (3, 4), 20: (4, 5), 25: (5, 5)})


class GridSiteAdapter:
    """Read-only, domain-agnostic structural adapter for visual test grids."""

    def __init__(self, seleniumbase_cdp: Any, *, overrides: Dict[str, str] | None = None) -> None:
        self._sb = seleniumbase_cdp
        self._overrides = self._clean_overrides(overrides or {})
        self._generation = 0
        self._last_signature = ""

    @classmethod
    def from_json(cls, seleniumbase_cdp: Any, path: str | Path | None) -> "GridSiteAdapter":
        if not path:
            return cls(seleniumbase_cdp)
        raw = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("Site adapter override file must contain a JSON object.")
        return cls(seleniumbase_cdp, overrides={str(k): str(v) for k, v in raw.items()})

    def poll(self) -> Dict[str, Any]:
        snapshot = self._snapshot_document()
        if snapshot.get("kind") == "none":
            snapshot = self._snapshot_nested_frames()
        return self._with_generation(snapshot)

    def _snapshot_document(self) -> Dict[str, Any]:
        overrides = json.dumps(self._overrides)
        grid_sizes = json.dumps({str(k): list(v) for k, v in _GRID_SIZES.items()})
        script = f"""
        (() => {{
          const overrides = {overrides};
          const GRID = new Map(Object.entries({grid_sizes}).map(([k,v]) => [Number(k), v]));
          const visible = el => {{
            if (!el?.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width >= 24 && r.height >= 24 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
          }};
          const text = el => (el?.innerText || el?.textContent || '').trim().replace(/\\s+/g, ' ');
          const bgUrl = el => {{
            if (!el || !visible(el)) return '';
            const bg = getComputedStyle(el).backgroundImage || '';
            const match = bg.match(/url\\(["']?(.*?)["']?\\)/i);
            return match?.[1] || '';
          }};
          const canvasSource = canvas => {{
            try {{ return canvas?.toDataURL?.('image/png') || ''; }} catch (_) {{ return ''; }}
          }};
          const sourceOf = tile => {{
            if (!tile) return '';
            const img = tile.matches?.('img') ? tile : tile.querySelector?.('img');
            if (img) return img.currentSrc || img.src || img.getAttribute('src') || img.getAttribute('data-src') || '';
            const canvas = tile.matches?.('canvas') ? tile : tile.querySelector?.('canvas');
            if (canvas) return canvasSource(canvas);
            return bgUrl(tile);
          }};
          const tileFor = visual => visual.closest?.('button,[role="button"],[tabindex],label,li,[class*="tile" i],[class*="cell" i]') || visual;
          const visualsIn = root => {{
            const items = [...(root.querySelectorAll?.('img,canvas') || [])].filter(visible);
            const bgCandidates = [...(root.querySelectorAll?.('button,[role="button"],[tabindex],label,li,[class*="tile" i],[class*="cell" i],[class*="image" i]') || [])]
              .filter(el => visible(el) && bgUrl(el));
            return [...new Set([...items, ...bgCandidates])];
          }};
          const roots = [], seen = new Set();
          const walkRoot = (root, label) => {{
            if (!root || seen.has(root)) return;
            seen.add(root); roots.push([root, label]);
            for (const el of root.querySelectorAll?.('*') || []) if (el.shadowRoot) walkRoot(el.shadowRoot, label + '/shadow');
            for (const frame of root.querySelectorAll?.('iframe') || []) {{
              try {{ if (frame.contentDocument) walkRoot(frame.contentDocument, label + '/iframe'); }} catch (_) {{}}
            }}
          }};
          const instructionNear = (root, groupRoot) => {{
            if (overrides.instruction) return root.querySelector(overrides.instruction);
            if (groupRoot?.previousElementSibling) return groupRoot.previousElementSibling;
            const parent = groupRoot?.parentElement;
            if (!parent) return null;
            const choices = [...parent.querySelectorAll('h1,h2,h3,h4,p,[class*="instruction" i],[class*="prompt" i],[class*="question" i]')].filter(visible);
            return choices.find(el => el.compareDocumentPosition(groupRoot) & Node.DOCUMENT_POSITION_FOLLOWING) || choices[0] || null;
          }};
          walkRoot(document, 'document');

          const candidates = [];
          for (const [root, scope] of roots) {{
            const groups = [];
            if (overrides.tiles) {{
              const tiles = [...root.querySelectorAll(overrides.tiles)].filter(visible);
              if (GRID.has(tiles.length)) groups.push({{root: overrides.root ? root.querySelector(overrides.root) || root : root, tiles, override:true}});
            }}

            if (!groups.length) {{
              const parents = new Set();
              for (const visual of visualsIn(root)) {{
                let node = tileFor(visual);
                for (let depth=0; node && depth<5; depth++, node=node.parentElement) if (node.parentElement) parents.add(node.parentElement);
              }}
              for (const parent of parents) {{
                const tiles = [...new Set(visualsIn(parent).map(tileFor))].filter(visible);
                if (!GRID.has(tiles.length)) continue;
                groups.push({{root:parent, tiles, override:false}});
              }}
            }}

            for (const group of groups) {{
              const count = group.tiles.length;
              if (!GRID.has(count)) continue;
              const [rows, columns] = GRID.get(count);
              const rects = group.tiles.map(tile => tile.getBoundingClientRect());
              const avgW = rects.reduce((a,r) => a+r.width,0)/count;
              const avgH = rects.reduce((a,r) => a+r.height,0)/count;
              const regular = rects.filter(r => Math.abs(r.width-avgW)<=Math.max(12,avgW*.35) && Math.abs(r.height-avgH)<=Math.max(12,avgH*.35)).length;
              const clickable = group.tiles.filter(tile => Boolean(tile.matches?.('button,[role="button"],[tabindex],label') || tile.onclick)).length;
              const sources = group.tiles.map(sourceOf);
              const sourceCount = sources.filter(Boolean).length;
              const instructionEl = instructionNear(root, group.root);
              const submitEl = overrides.submit
                ? root.querySelector(overrides.submit)
                : [...(group.root.parentElement?.querySelectorAll('button[type="submit"],input[type="submit"],button,[role="button"]') || [])].find(el => visible(el) && !group.tiles.includes(el)) || null;
              let score = 40;
              score += sourceCount === count ? 25 : Math.round(15*sourceCount/count);
              score += Math.round(15*regular/count);
              score += Math.round(10*clickable/count);
              if (group.override) score += 20;
              if (submitEl) score += 5;
              if (text(instructionEl)) score += 5;
              candidates.push({{
                kind:'image-grid', scope, score, rows, columns, tileCount:count,
                instruction:text(instructionEl).slice(0,600), sources,
                submitText:text(submitEl).slice(0,120), override:group.override,
              }});
            }}
          }}
          candidates.sort((a,b) => b.score-a.score);
          return candidates[0] || {{kind:'none',scope:'document',score:0,rows:0,columns:0,tileCount:0,instruction:'',sources:[],submitText:'',override:false}};
        }})()
        """
        try:
            value = self._evaluate(script)
        except Exception:
            return self._empty("document")
        return self._normalize(value, default_scope="document")

    def _snapshot_nested_frames(self) -> Dict[str, Any]:
        try:
            frames = list(self._sb.find_elements("iframe") or [])
        except Exception:
            return self._empty("iframe")

        best = self._empty("iframe")
        for frame_index, frame in enumerate(frames):
            try:
                images = [img for img in (frame.query_selector_all("img") or []) if self._element_visible(img)]
            except Exception:
                continue
            if len(images) not in _GRID_SIZES:
                continue
            rows, columns = _GRID_SIZES[len(images)]
            sources = [self._element_image_source(img) for img in images]
            score = 55 + (25 if all(sources) else 10)
            candidate = {
                "kind": "image-grid",
                "scope": f"iframe:{frame_index}",
                "score": score,
                "rows": rows,
                "columns": columns,
                "tileCount": len(images),
                "instruction": self._frame_descriptor(frame),
                "sources": sources,
                "submitText": "",
                "override": False,
            }
            if score > int(best.get("score") or 0):
                best = candidate
        return best

    def _with_generation(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        signature_input = "|".join([
            str(snapshot.get("kind") or "none"),
            str(snapshot.get("scope") or ""),
            str(snapshot.get("tileCount") or 0),
            str(snapshot.get("instruction") or ""),
            *(str(value) for value in snapshot.get("sources") or []),
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
        executor = getattr(self._sb, "execute_script", None)
        if callable(executor):
            return executor(f"return {script};")
        raise RuntimeError("SeleniumBase CDP adapter has no script evaluation method")

    @staticmethod
    def _clean_overrides(values: Dict[str, str]) -> Dict[str, str]:
        allowed = {"root", "tiles", "instruction", "submit", "complete", "failed"}
        return {key: str(value).strip() for key, value in values.items() if key in allowed and str(value).strip()}

    @staticmethod
    def _normalize(value: Any, *, default_scope: str) -> Dict[str, Any]:
        if not isinstance(value, dict):
            return GridSiteAdapter._empty(default_scope)
        return {
            "kind": str(value.get("kind") or "none"),
            "scope": str(value.get("scope") or default_scope),
            "score": int(value.get("score") or 0),
            "rows": int(value.get("rows") or 0),
            "columns": int(value.get("columns") or 0),
            "tileCount": int(value.get("tileCount") or 0),
            "instruction": str(value.get("instruction") or ""),
            "sources": [str(item) for item in value.get("sources") or []],
            "submitText": str(value.get("submitText") or ""),
            "override": bool(value.get("override")),
        }

    @staticmethod
    def _empty(scope: str) -> Dict[str, Any]:
        return {"kind":"none","scope":scope,"score":0,"rows":0,"columns":0,"tileCount":0,"instruction":"","sources":[],"submitText":"","override":False}

    @staticmethod
    def _element_visible(element: Any) -> bool:
        try:
            position = element.get_position()
        except Exception:
            position = None
        if isinstance(position, dict):
            try:
                return float(position.get("width") or 0) >= 24 and float(position.get("height") or 0) >= 24
            except (TypeError, ValueError):
                return False
        return True

    @staticmethod
    def _element_image_source(element: Any) -> str:
        for name in ("src", "currentSrc", "data-src"):
            try:
                value = element.get_attribute(name)
            except Exception:
                value = None
            if value:
                return str(value)
        return ""

    @staticmethod
    def _frame_descriptor(frame: Any) -> str:
        parts: List[str] = []
        for name in ("title", "name", "id", "src"):
            try:
                value = frame.get_attribute(name)
            except Exception:
                value = None
            if value:
                parts.append(str(value))
        return " ".join(parts)[:600]
