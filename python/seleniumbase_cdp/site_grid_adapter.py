from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

from stable_marks import build_stable_marks, stable_mark_digest


_MIN_GRID_SIDE = 2
_MAX_GRID_SIDE = 8
_MIN_GRID_TILES = _MIN_GRID_SIDE * _MIN_GRID_SIDE
_MAX_GRID_TILES = _MAX_GRID_SIDE * _MAX_GRID_SIDE


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
        script = f"""
        (() => {{
          const overrides = {overrides};
          const minSide = {_MIN_GRID_SIDE};
          const maxSide = {_MAX_GRID_SIDE};
          const minTiles = {_MIN_GRID_TILES};
          const maxTiles = {_MAX_GRID_TILES};
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
            return r.width >= 24 && r.height >= 24 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
          }};
          const text = el => (el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').trim().replace(/\\s+/g, ' ');
          const rectOf = el => {{ const r=el.getBoundingClientRect(); return {{x:r.x,y:r.y,width:r.width,height:r.height}}; }};
          const supportedCount = count => count >= minTiles && count <= maxTiles;
          const clusterCount = (values, tolerance) => {{
            const sorted = [...values].sort((a,b) => a-b);
            const clusters = [];
            for (const value of sorted) {{
              const last = clusters[clusters.length - 1];
              if (!last || Math.abs(value - last.center) > tolerance) clusters.push({{center:value,count:1}});
              else {{ last.center = (last.center * last.count + value) / (last.count + 1); last.count += 1; }}
            }}
            return clusters.length;
          }};
          const inferShape = rects => {{
            const count = rects.length;
            if (!supportedCount(count)) return null;
            const avgW = rects.reduce((a,r) => a+r.width,0)/count;
            const avgH = rects.reduce((a,r) => a+r.height,0)/count;
            const xs = rects.map(r => r.left + r.width/2);
            const ys = rects.map(r => r.top + r.height/2);
            const columns = clusterCount(xs, Math.max(5, avgW*.45));
            const rows = clusterCount(ys, Math.max(5, avgH*.45));
            if (rows < minSide || columns < minSide || rows > maxSide || columns > maxSide) return null;
            if (rows * columns !== count) return null;
            return [rows, columns];
          }};
          const selectorFor = el => {{
            if (!el || el.getRootNode?.() !== document) return '';
            if (el.id) return '#' + CSS.escape(el.id);
            const testId = el.getAttribute?.('data-testid');
            if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
            const name = el.getAttribute?.('name');
            if (name) return `${{el.tagName.toLowerCase()}}[name="${{CSS.escape(name)}}"]`;
            return '';
          }};
          const structuralKey = (el, index) => {{
            const selector = selectorFor(el);
            if (selector) return selector;
            const id = el?.getAttribute?.('id') || '';
            const testId = el?.getAttribute?.('data-testid') || '';
            const aria = el?.getAttribute?.('aria-label') || '';
            const role = el?.getAttribute?.('role') || '';
            const cls = typeof el?.className === 'string' ? el.className.trim().split(/\\s+/).slice(0,4).join('.') : '';
            return ['grid-tile',el?.tagName||'',id,testId,aria,role,cls,`slot:${{index}}`].join('|');
          }};
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
          const semanticSignature = (tile, source) => {{
            const img = tile?.matches?.('img') ? tile : tile?.querySelector?.('img');
            const alt = img?.getAttribute?.('alt') || tile?.getAttribute?.('aria-label') || text(tile).slice(0,180);
            return ['grid-tile',alt,source].join('|');
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
              if (supportedCount(tiles.length)) groups.push({{root: overrides.root ? root.querySelector(overrides.root) || root : root, tiles, override:true}});
            }}

            if (!groups.length) {{
              const parents = new Set();
              for (const visual of visualsIn(root)) {{
                let node = tileFor(visual);
                for (let depth=0; node && depth<5; depth++, node=node.parentElement) if (node.parentElement) parents.add(node.parentElement);
              }}
              for (const parent of parents) {{
                const tiles = [...new Set(visualsIn(parent).map(tileFor))].filter(visible);
                if (!supportedCount(tiles.length)) continue;
                groups.push({{root:parent, tiles, override:false}});
              }}
            }}

            for (const group of groups) {{
              const count = group.tiles.length;
              const rects = group.tiles.map(tile => tile.getBoundingClientRect());
              const shape = inferShape(rects);
              if (!shape) continue;
              const [rows, columns] = shape;
              const avgW = rects.reduce((a,r) => a+r.width,0)/count;
              const avgH = rects.reduce((a,r) => a+r.height,0)/count;
              const regular = rects.filter(r => Math.abs(r.width-avgW)<=Math.max(12,avgW*.35) && Math.abs(r.height-avgH)<=Math.max(12,avgH*.35)).length;
              const clickableFlags = group.tiles.map(tile => Boolean(tile.matches?.('button,[role="button"],[tabindex],label') || tile.onclick));
              const clickable = clickableFlags.filter(Boolean).length;
              const sources = group.tiles.map(sourceOf);
              const sourceCount = sources.filter(Boolean).length;
              const rawMarks = group.tiles.map((tile,index) => ({{
                role:'grid-tile',
                visualBounds:rectOf(tile),
                confidence:Math.max(0.58,Math.min(0.98,0.68 + (sources[index] ? 0.18 : 0) + (clickableFlags[index] ? 0.10 : 0))),
                selector:selectorFor(tile),
                structuralKey:structuralKey(tile,index),
                semanticSignature:semanticSignature(tile,sources[index]),
                source:sources[index],
                label:text(tile).slice(0,160),
                score:index,
              }}));
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
                rawMarks, viewport,
              }});
            }}
          }}
          candidates.sort((a,b) => b.score-a.score);
          return candidates[0] || {{kind:'none',scope:'document',score:0,rows:0,columns:0,tileCount:0,instruction:'',sources:[],submitText:'',override:false,rawMarks:[],viewport}};
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
            shape = self._infer_shape([self._element_position(image) for image in images])
            if shape is None:
                continue
            rows, columns = shape
            sources = [self._element_image_source(img) for img in images]
            scope = f"iframe:{frame_index}"
            raw_marks = []
            for index, image in enumerate(images):
                alt = self._element_attribute(image, "alt")
                identity = self._element_attribute(image, "id") or self._element_attribute(image, "data-testid") or f"slot:{index}"
                raw_marks.append({
                    "role": "grid-tile",
                    "visualBounds": self._element_position(image),
                    "confidence": 0.92 if sources[index] else 0.70,
                    "structuralKey": f"img|{identity}",
                    "semanticSignature": f"grid-tile|{alt}|{sources[index]}",
                    "source": sources[index],
                    "label": alt,
                    "score": index,
                })
            marks = build_stable_marks(raw_marks, scope=scope, viewport={})
            score = 55 + (25 if all(sources) else 10)
            candidate = {
                "kind": "image-grid",
                "scope": scope,
                "score": score,
                "rows": rows,
                "columns": columns,
                "tileCount": len(images),
                "instruction": self._frame_descriptor(frame),
                "sources": sources,
                "submitText": "",
                "override": False,
                "marks": marks,
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
            stable_mark_digest(snapshot.get("marks") or []),
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
        scope = str(value.get("scope") or default_scope)
        marks = build_stable_marks(
            [dict(item) for item in value.get("rawMarks") or [] if isinstance(item, dict)],
            scope=scope,
            viewport=value.get("viewport") if isinstance(value.get("viewport"), dict) else {},
        )
        return {
            "kind": str(value.get("kind") or "none"),
            "scope": scope,
            "score": int(value.get("score") or 0),
            "rows": int(value.get("rows") or 0),
            "columns": int(value.get("columns") or 0),
            "tileCount": int(value.get("tileCount") or 0),
            "instruction": str(value.get("instruction") or ""),
            "sources": [str(item) for item in value.get("sources") or []],
            "submitText": str(value.get("submitText") or ""),
            "override": bool(value.get("override")),
            "marks": marks,
        }

    @staticmethod
    def _empty(scope: str) -> Dict[str, Any]:
        return {"kind":"none","scope":scope,"score":0,"rows":0,"columns":0,"tileCount":0,"instruction":"","sources":[],"submitText":"","override":False,"marks":[]}

    @staticmethod
    def _infer_shape(positions: List[Dict[str, Any] | None]) -> Tuple[int, int] | None:
        clean = [position for position in positions if isinstance(position, dict)]
        count = len(clean)
        if count < _MIN_GRID_TILES or count > _MAX_GRID_TILES or count != len(positions):
            return None
        try:
            widths = [float(position.get("width") or 0.0) for position in clean]
            heights = [float(position.get("height") or 0.0) for position in clean]
            xs = [float(position.get("x") or 0.0) + widths[index] / 2.0 for index, position in enumerate(clean)]
            ys = [float(position.get("y") or 0.0) + heights[index] / 2.0 for index, position in enumerate(clean)]
        except (TypeError, ValueError):
            return None
        avg_w = sum(widths) / count
        avg_h = sum(heights) / count
        columns = GridSiteAdapter._cluster_count(xs, max(5.0, avg_w * 0.45))
        rows = GridSiteAdapter._cluster_count(ys, max(5.0, avg_h * 0.45))
        if not (_MIN_GRID_SIDE <= rows <= _MAX_GRID_SIDE and _MIN_GRID_SIDE <= columns <= _MAX_GRID_SIDE):
            return None
        if rows * columns != count:
            return None
        return rows, columns

    @staticmethod
    def _cluster_count(values: List[float], tolerance: float) -> int:
        centers: List[List[float]] = []
        for value in sorted(values):
            if not centers or abs(value - centers[-1][0]) > tolerance:
                centers.append([value, 1.0])
                continue
            center, size = centers[-1]
            size += 1.0
            centers[-1] = [(center * (size - 1.0) + value) / size, size]
        return len(centers)

    @staticmethod
    def _element_visible(element: Any) -> bool:
        position = GridSiteAdapter._element_position(element)
        if isinstance(position, dict):
            try:
                return float(position.get("width") or 0) >= 24 and float(position.get("height") or 0) >= 24
            except (TypeError, ValueError):
                return False
        return True

    @staticmethod
    def _element_position(element: Any) -> Dict[str, Any] | None:
        try:
            position = element.get_position()
        except Exception:
            return None
        return dict(position) if isinstance(position, dict) else None

    @staticmethod
    def _element_attribute(element: Any, name: str) -> str:
        try:
            value = element.get_attribute(name)
        except Exception:
            value = None
        return str(value or "")

    @staticmethod
    def _element_image_source(element: Any) -> str:
        for name in ("src", "currentSrc", "data-src"):
            value = GridSiteAdapter._element_attribute(element, name)
            if value:
                return value
        return ""

    @staticmethod
    def _frame_descriptor(frame: Any) -> str:
        parts: List[str] = []
        for name in ("title", "name", "id", "src"):
            value = GridSiteAdapter._element_attribute(frame, name)
            if value:
                parts.append(value)
        return " ".join(parts)[:600]
