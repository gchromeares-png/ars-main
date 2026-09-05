from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List


_GRID_SIZES = {9: (3, 3), 16: (4, 4)}


class GridSiteAdapter:
    """Read-only structural adapter for authorized image-grid test pages.

    The adapter is domain-agnostic. It first tries optional selector overrides,
    then generic DOM/open-shadow-root discovery, and finally SeleniumBase CDP
    iframe element traversal. It returns one neutral snapshot consumed by later
    demo/vision layers; it never clicks, submits, or invokes solver behavior.
    """

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
          const GRID = new Map([[9, [3, 3]], [16, [4, 4]]]);
          const visible = (el) => {{
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width >= 24 && r.height >= 24 && s.display !== 'none' && s.visibility !== 'hidden';
          }};
          const text = (el) => (el && (el.innerText || el.textContent) || '').trim().replace(/\\s+/g, ' ');
          const imgSource = (tile) => {{
            const img = tile && tile.matches && tile.matches('img') ? tile : tile && tile.querySelector && tile.querySelector('img');
            if (img) return img.currentSrc || img.src || img.getAttribute('src') || '';
            if (!tile || !getComputedStyle) return '';
            const bg = getComputedStyle(tile).backgroundImage || '';
            return bg === 'none' ? '' : bg;
          }};
          const roots = [];
          const seen = new Set();
          const walkRoot = (root, label) => {{
            if (!root || seen.has(root)) return;
            seen.add(root); roots.push([root, label]);
            const all = root.querySelectorAll ? [...root.querySelectorAll('*')] : [];
            for (const el of all) if (el.shadowRoot) walkRoot(el.shadowRoot, label + '/shadow');
            for (const frame of root.querySelectorAll ? [...root.querySelectorAll('iframe')] : []) {{
              try {{ if (frame.contentDocument) walkRoot(frame.contentDocument, label + '/iframe'); }} catch (_) {{}}
            }}
          }};
          walkRoot(document, 'document');

          const resolveOverride = (root, key) => overrides[key] && root.querySelector ? root.querySelector(overrides[key]) : null;
          const resolveOverrideAll = (root, key) => overrides[key] && root.querySelectorAll ? [...root.querySelectorAll(overrides[key])] : [];

          const candidates = [];
          for (const [root, scope] of roots) {{
            let groups = [];
            if (overrides.tiles) {{
              const tiles = resolveOverrideAll(root, 'tiles').filter(visible);
              if (GRID.has(tiles.length)) groups.push({{root: resolveOverride(root, 'root') || root, tiles, override: true}});
            }}
            if (!groups.length) {{
              const parents = new Set();
              const images = root.querySelectorAll ? [...root.querySelectorAll('img')].filter(visible) : [];
              for (const img of images) {{
                let node = img;
                for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {{
                  if (node.parentElement) parents.add(node.parentElement);
                }}
              }}
              for (const parent of parents) {{
                const descendants = [...parent.querySelectorAll('img')].filter(visible);
                if (!GRID.has(descendants.length)) continue;
                const tiles = descendants.map((img) => img.closest('button,[role="button"],[tabindex],label,li,div') || img);
                groups.push({{root: parent, tiles, override: false}});
              }}
            }}

            for (const group of groups) {{
              const count = group.tiles.length;
              if (!GRID.has(count)) continue;
              const [rows, columns] = GRID.get(count);
              const rects = group.tiles.map((tile) => tile.getBoundingClientRect());
              const avgW = rects.reduce((a, r) => a + r.width, 0) / count;
              const avgH = rects.reduce((a, r) => a + r.height, 0) / count;
              const regular = rects.filter((r) => Math.abs(r.width-avgW) <= Math.max(12, avgW*.35) && Math.abs(r.height-avgH) <= Math.max(12, avgH*.35)).length;
              const clickable = group.tiles.filter((tile) => tile.matches && tile.matches('button,[role="button"],[tabindex],label') || tile.onclick).length;
              const sources = group.tiles.map(imgSource);
              const sourceCount = sources.filter(Boolean).length;
              const instructionEl = resolveOverride(root, 'instruction') || group.root.previousElementSibling || group.root.parentElement;
              const submitEl = resolveOverride(root, 'submit') || [...(group.root.parentElement?.querySelectorAll('button,input[type="submit"],[role="button"]') || [])].find(visible) || null;
              let score = 40;
              score += sourceCount === count ? 25 : Math.round(15 * sourceCount / count);
              score += Math.round(15 * regular / count);
              score += Math.round(10 * clickable / count);
              if (group.override) score += 20;
              if (submitEl) score += 5;
              if (text(instructionEl)) score += 5;
              candidates.push({{
                kind: 'image-grid', scope, score, rows, columns, tileCount: count,
                instruction: text(instructionEl).slice(0, 600),
                sources,
                submitText: text(submitEl).slice(0, 120),
                override: group.override,
              }});
            }}
          }}
          candidates.sort((a,b) => b.score-a.score);
          return candidates[0] || {{kind:'none', scope:'document', score:0, rows:0, columns:0, tileCount:0, instruction:'', sources:[], submitText:'', override:false}};
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
        signature_input = "|".join(
            [
                str(snapshot.get("kind") or "none"),
                str(snapshot.get("scope") or ""),
                str(snapshot.get("tileCount") or 0),
                str(snapshot.get("instruction") or ""),
                *(str(value) for value in snapshot.get("sources") or []),
            ]
        )
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
        sources = [str(item) for item in value.get("sources") or []]
        return {
            "kind": str(value.get("kind") or "none"),
            "scope": str(value.get("scope") or default_scope),
            "score": int(value.get("score") or 0),
            "rows": int(value.get("rows") or 0),
            "columns": int(value.get("columns") or 0),
            "tileCount": int(value.get("tileCount") or 0),
            "instruction": str(value.get("instruction") or ""),
            "sources": sources,
            "submitText": str(value.get("submitText") or ""),
            "override": bool(value.get("override")),
        }

    @staticmethod
    def _empty(scope: str) -> Dict[str, Any]:
        return {"kind": "none", "scope": scope, "score": 0, "rows": 0, "columns": 0, "tileCount": 0, "instruction": "", "sources": [], "submitText": "", "override": False}

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
