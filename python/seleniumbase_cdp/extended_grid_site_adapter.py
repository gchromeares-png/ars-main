from __future__ import annotations

from typing import Any, Dict, List, Tuple

from site_grid_adapter import GridSiteAdapter
from stable_marks import build_stable_marks


class ExtendedGridSiteAdapter(GridSiteAdapter):
    """Grid adapter fallback that infers regular 2x2..8x8 layouts by geometry."""

    MIN_DIM = 2
    MAX_DIM = 8
    MIN_COUNT = MIN_DIM * MIN_DIM
    MAX_COUNT = MAX_DIM * MAX_DIM

    def poll(self) -> Dict[str, Any]:
        snapshot = self._snapshot_document()
        if snapshot.get("kind") == "none":
            snapshot = self._snapshot_extended_document()
        if snapshot.get("kind") == "none":
            snapshot = self._snapshot_nested_frames()
        if snapshot.get("kind") == "none":
            snapshot = self._snapshot_extended_frames()
        return self._with_generation(snapshot)

    def _snapshot_extended_document(self) -> Dict[str, Any]:
        script = r"""
        (() => {
          const MIN_DIM = 2, MAX_DIM = 8, MIN_COUNT = 4, MAX_COUNT = 64;
          const viewport = {
            width: window.innerWidth || document.documentElement.clientWidth || 0,
            height: window.innerHeight || document.documentElement.clientHeight || 0,
            scrollX: window.scrollX || 0,
            scrollY: window.scrollY || 0,
            devicePixelRatio: window.devicePixelRatio || 1,
          };
          const visible = el => {
            if (!el?.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width >= 20 && r.height >= 20
              && s.display !== 'none'
              && s.visibility !== 'hidden'
              && Number(s.opacity || 1) > 0;
          };
          const text = el => (el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '')
            .trim().replace(/\s+/g, ' ');
          const rectOf = el => {
            const r = el.getBoundingClientRect();
            return {x:r.x,y:r.y,width:r.width,height:r.height};
          };
          const selectorFor = el => {
            if (!el || el.getRootNode?.() !== document) return '';
            if (el.id) return '#' + CSS.escape(el.id);
            const testId = el.getAttribute?.('data-testid');
            if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
            return '';
          };
          const bgUrl = el => {
            if (!el || !visible(el)) return '';
            const bg = getComputedStyle(el).backgroundImage || '';
            const match = bg.match(/url\(["']?(.*?)["']?\)/i);
            return match?.[1] || '';
          };
          const sourceOf = tile => {
            const img = tile?.matches?.('img') ? tile : tile?.querySelector?.('img');
            if (img) return img.currentSrc || img.src || img.getAttribute('src') || img.getAttribute('data-src') || '';
            const canvas = tile?.matches?.('canvas') ? tile : tile?.querySelector?.('canvas');
            if (canvas) {
              try { return canvas.toDataURL?.('image/png') || ''; } catch (_) { return ''; }
            }
            return bgUrl(tile);
          };
          const tileFor = visual => visual.closest?.(
            'button,[role="button"],[tabindex],label,li,[class*="tile" i],[class*="cell" i]'
          ) || visual;
          const visualsIn = root => {
            const direct = [...(root.querySelectorAll?.('img,canvas') || [])].filter(visible);
            const backgrounds = [...(root.querySelectorAll?.(
              'button,[role="button"],[tabindex],label,li,[class*="tile" i],[class*="cell" i],[class*="image" i]'
            ) || [])].filter(el => visible(el) && bgUrl(el));
            return [...new Set([...direct, ...backgrounds])];
          };
          const clusterCount = (values, tolerance) => {
            const sorted = [...values].sort((a,b) => a-b);
            const clusters = [];
            for (const value of sorted) {
              const last = clusters[clusters.length - 1];
              if (!last || Math.abs(value - last.mean) > tolerance) {
                clusters.push({mean:value,count:1});
              } else {
                last.mean = (last.mean * last.count + value) / (last.count + 1);
                last.count += 1;
              }
            }
            return clusters.length;
          };
          const inferShape = tiles => {
            const rects = tiles.map(el => el.getBoundingClientRect());
            const avgW = rects.reduce((a,r) => a+r.width,0) / rects.length;
            const avgH = rects.reduce((a,r) => a+r.height,0) / rects.length;
            const rowTolerance = Math.max(6, Math.min(36, avgH * 0.45));
            const colTolerance = Math.max(6, Math.min(36, avgW * 0.45));
            const rows = clusterCount(rects.map(r => r.top + r.height/2), rowTolerance);
            const columns = clusterCount(rects.map(r => r.left + r.width/2), colTolerance);
            if (rows < MIN_DIM || columns < MIN_DIM || rows > MAX_DIM || columns > MAX_DIM) return null;
            if (rows * columns !== tiles.length) return null;
            const regular = rects.filter(r =>
              Math.abs(r.width-avgW) <= Math.max(10, avgW*.28)
              && Math.abs(r.height-avgH) <= Math.max(10, avgH*.28)
            ).length;
            if (regular / tiles.length < 0.82) return null;
            return {rows, columns, regular};
          };
          const roots = [], seen = new Set();
          const walk = (root, scope) => {
            if (!root || seen.has(root)) return;
            seen.add(root);
            roots.push([root, scope]);
            for (const el of root.querySelectorAll?.('*') || []) if (el.shadowRoot) walk(el.shadowRoot, scope + '/shadow');
            for (const frame of root.querySelectorAll?.('iframe') || []) {
              try { if (frame.contentDocument) walk(frame.contentDocument, scope + '/iframe'); } catch (_) {}
            }
          };
          const instructionNear = groupRoot => {
            if (groupRoot?.previousElementSibling && visible(groupRoot.previousElementSibling)) return groupRoot.previousElementSibling;
            const parent = groupRoot?.parentElement;
            if (!parent) return null;
            return [...parent.querySelectorAll(
              'h1,h2,h3,h4,p,[class*="instruction" i],[class*="prompt" i],[class*="question" i]'
            )].find(visible) || null;
          };
          walk(document, 'document');

          const candidates = [];
          for (const [root, scope] of roots) {
            const parents = new Set();
            for (const visual of visualsIn(root)) {
              let node = tileFor(visual);
              for (let depth=0; node && depth<5; depth++, node=node.parentElement) {
                if (node.parentElement) parents.add(node.parentElement);
              }
            }

            for (const parent of parents) {
              const tiles = [...new Set(visualsIn(parent).map(tileFor))].filter(visible);
              const count = tiles.length;
              if (count < MIN_COUNT || count > MAX_COUNT) continue;
              const shape = inferShape(tiles);
              if (!shape) continue;

              const sources = tiles.map(sourceOf);
              const sourceCount = sources.filter(Boolean).length;
              const rawMarks = tiles.map((tile,index) => ({
                role:'grid-tile',
                visualBounds:rectOf(tile),
                confidence:Math.max(0.60, Math.min(0.97, 0.70 + (sources[index] ? 0.17 : 0))),
                selector:selectorFor(tile),
                structuralKey:[
                  'grid-tile',
                  tile?.tagName || '',
                  tile?.getAttribute?.('id') || '',
                  tile?.getAttribute?.('data-testid') || '',
                  tile?.getAttribute?.('aria-label') || '',
                  `slot:${index}`,
                ].join('|'),
                semanticSignature:['grid-tile', text(tile).slice(0,160), sources[index]].join('|'),
                source:sources[index],
                label:text(tile).slice(0,160),
                score:index,
              }));
              const instructionEl = instructionNear(parent);
              const submitEl = [...(parent.parentElement?.querySelectorAll(
                'button[type="submit"],input[type="submit"],button,[role="button"]'
              ) || [])].find(el => visible(el) && !tiles.includes(el)) || null;
              let score = 56;
              score += Math.round(20 * sourceCount / count);
              score += Math.round(14 * shape.regular / count);
              if (text(instructionEl)) score += 6;
              if (submitEl) score += 4;
              candidates.push({
                kind:'image-grid',
                scope,
                score,
                rows:shape.rows,
                columns:shape.columns,
                tileCount:count,
                instruction:text(instructionEl).slice(0,600),
                sources,
                submitText:text(submitEl).slice(0,120),
                override:false,
                rawMarks,
                viewport,
              });
            }
          }
          candidates.sort((a,b) => b.score-a.score);
          return candidates[0] || {
            kind:'none',scope:'document',score:0,rows:0,columns:0,tileCount:0,
            instruction:'',sources:[],submitText:'',override:false,rawMarks:[],viewport
          };
        })()
        """
        try:
            value = self._evaluate(script)
        except Exception:
            return self._empty("document")
        return self._normalize(value, default_scope="document")

    def _snapshot_extended_frames(self) -> Dict[str, Any]:
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
            if not (self.MIN_COUNT <= len(images) <= self.MAX_COUNT):
                continue

            rects = [self._element_position(image) for image in images]
            shape = self._infer_shape(rects)
            if shape is None:
                continue
            rows, columns = shape
            sources = [self._element_image_source(img) for img in images]
            scope = f"iframe:{frame_index}"
            raw_marks = []
            for index, image in enumerate(images):
                alt = self._element_attribute(image, "alt")
                identity = (
                    self._element_attribute(image, "id")
                    or self._element_attribute(image, "data-testid")
                    or f"slot:{index}"
                )
                raw_marks.append({
                    "role": "grid-tile",
                    "visualBounds": rects[index],
                    "confidence": 0.92 if sources[index] else 0.70,
                    "structuralKey": f"img|{identity}",
                    "semanticSignature": f"grid-tile|{alt}|{sources[index]}",
                    "source": sources[index],
                    "label": alt,
                    "score": index,
                })
            marks = build_stable_marks(raw_marks, scope=scope, viewport={})
            score = 62 + (20 if all(sources) else 8)
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

    @classmethod
    def _infer_shape(cls, rects: List[Dict[str, Any] | None]) -> Tuple[int, int] | None:
        if not rects or any(not isinstance(rect, dict) for rect in rects):
            return None
        try:
            widths = [float(rect.get("width") or 0.0) for rect in rects if isinstance(rect, dict)]
            heights = [float(rect.get("height") or 0.0) for rect in rects if isinstance(rect, dict)]
            centers_x = [
                float(rect.get("x") or 0.0) + float(rect.get("width") or 0.0) / 2.0
                for rect in rects if isinstance(rect, dict)
            ]
            centers_y = [
                float(rect.get("y") or 0.0) + float(rect.get("height") or 0.0) / 2.0
                for rect in rects if isinstance(rect, dict)
            ]
        except (TypeError, ValueError):
            return None
        if not widths or min(widths) <= 0 or min(heights) <= 0:
            return None
        avg_w = sum(widths) / len(widths)
        avg_h = sum(heights) / len(heights)
        rows = cls._cluster_count(centers_y, max(6.0, min(36.0, avg_h * 0.45)))
        columns = cls._cluster_count(centers_x, max(6.0, min(36.0, avg_w * 0.45)))
        if not (cls.MIN_DIM <= rows <= cls.MAX_DIM and cls.MIN_DIM <= columns <= cls.MAX_DIM):
            return None
        return (rows, columns) if rows * columns == len(rects) else None

    @staticmethod
    def _cluster_count(values: List[float], tolerance: float) -> int:
        clusters: List[List[float]] = []
        for value in sorted(values):
            if not clusters or abs(value - (sum(clusters[-1]) / len(clusters[-1]))) > tolerance:
                clusters.append([value])
            else:
                clusters[-1].append(value)
        return len(clusters)
