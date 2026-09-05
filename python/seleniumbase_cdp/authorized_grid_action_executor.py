from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List


class AuthorizedGridActionExecutor:
    """Apply selected tile indexes on explicitly authorized test sessions only.

    The executor never decides which tiles are correct. It only receives indexes
    from a separate selection provider, re-resolves the live DOM, validates the
    expected grid shape/signature through the adapter, clicks the requested tiles,
    and optionally submits. This keeps recognition, classification, and browser
    interaction separate.
    """

    def __init__(self, seleniumbase_cdp: Any, grid_adapter: Any, *, authorized: bool = False) -> None:
        self._sb = seleniumbase_cdp
        self._grid_adapter = grid_adapter
        self._authorized = bool(authorized)

    @property
    def authorized(self) -> bool:
        return self._authorized

    def apply(
        self,
        indexes: Iterable[int],
        *,
        expected_signature: str = "",
        expected_tile_count: int | None = None,
        submit: bool = True,
    ) -> Dict[str, Any]:
        if not self._authorized:
            return {"status": "disabled", "clickedIndexes": []}

        selected = self._clean_indexes(indexes)
        before = self._grid_adapter.poll()
        if before.get("kind") != "image-grid":
            return {"status": "no-grid", "clickedIndexes": [], "state": before}

        tile_count = int(before.get("tileCount") or 0)
        if expected_tile_count is not None and tile_count != int(expected_tile_count):
            return {"status": "stale-grid", "reason": "tile-count-changed", "clickedIndexes": [], "state": before}
        if expected_signature and str(before.get("signature") or "") != str(expected_signature):
            return {"status": "stale-grid", "reason": "signature-changed", "clickedIndexes": [], "state": before}
        if any(index >= tile_count for index in selected):
            return {"status": "invalid-index", "clickedIndexes": [], "state": before}

        result = self._apply_document(selected, submit=submit)
        if result.get("status") == "unsupported-scope":
            result = self._apply_nested_frame(before, selected, submit=submit)

        after = self._grid_adapter.poll()
        return {
            **result,
            "beforeGeneration": int(before.get("generation") or 0),
            "afterGeneration": int(after.get("generation") or 0),
            "generationChanged": str(after.get("signature") or "") != str(before.get("signature") or ""),
            "state": after,
        }

    def _apply_document(self, indexes: List[int], *, submit: bool) -> Dict[str, Any]:
        overrides = json.dumps(getattr(self._grid_adapter, "_overrides", {}) or {})
        encoded_indexes = json.dumps(indexes)
        submit_flag = "true" if submit else "false"
        script = f"""
        (() => {{
          const overrides = {overrides};
          const wanted = {encoded_indexes};
          const shouldSubmit = {submit_flag};
          const visible = (el) => {{
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width >= 24 && r.height >= 24 && s.display !== 'none' && s.visibility !== 'hidden';
          }};
          const roots = [];
          const seen = new Set();
          const walk = (root) => {{
            if (!root || seen.has(root)) return;
            seen.add(root); roots.push(root);
            const all = root.querySelectorAll ? [...root.querySelectorAll('*')] : [];
            for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
            for (const frame of root.querySelectorAll ? [...root.querySelectorAll('iframe')] : []) {{
              try {{ if (frame.contentDocument) walk(frame.contentDocument); }} catch (_) {{}}
            }}
          }};
          walk(document);

          const resolveTiles = (root) => {{
            if (overrides.tiles && root.querySelectorAll) {{
              const explicit = [...root.querySelectorAll(overrides.tiles)].filter(visible);
              if (explicit.length === 9 || explicit.length === 16) return explicit;
            }}
            if (!root.querySelectorAll) return [];
            const parents = new Set();
            for (const img of [...root.querySelectorAll('img')].filter(visible)) {{
              let node = img;
              for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {{
                if (node.parentElement) parents.add(node.parentElement);
              }}
            }}
            let best = [];
            for (const parent of parents) {{
              const images = [...parent.querySelectorAll('img')].filter(visible);
              if (images.length !== 9 && images.length !== 16) continue;
              const tiles = images.map((img) => img.closest('button,[role="button"],[tabindex],label,li,div') || img);
              if (tiles.length > best.length) best = tiles;
            }}
            return best;
          }};

          for (const root of roots) {{
            const tiles = resolveTiles(root);
            if (tiles.length !== 9 && tiles.length !== 16) continue;
            const clicked = [];
            for (const index of wanted) {{
              const tile = tiles[index];
              if (!tile || !visible(tile)) return {{status:'stale-grid', reason:'tile-disappeared', clickedIndexes:clicked}};
              tile.scrollIntoView({{block:'center', inline:'center'}});
              tile.click(); clicked.push(index);
            }}
            let submitted = false;
            if (shouldSubmit) {{
              let submitEl = overrides.submit && root.querySelector ? root.querySelector(overrides.submit) : null;
              if (!submitEl) {{
                const scope = (tiles[0] && tiles[0].parentElement && tiles[0].parentElement.parentElement) || root;
                submitEl = [...(scope.querySelectorAll ? scope.querySelectorAll('button,input[type="submit"],[role="button"]') : [])]
                  .filter(visible)
                  .find((el) => !tiles.includes(el)) || null;
              }}
              if (submitEl && visible(submitEl)) {{ submitEl.click(); submitted = true; }}
            }}
            return {{status:'clicked', clickedIndexes:clicked, submitted, strategy:'dom'}};
          }}
          return {{status:'unsupported-scope', clickedIndexes:[], submitted:false, strategy:'dom'}};
        }})()
        """
        try:
            value = self._evaluate(script)
        except Exception as exc:
            return {"status": "unsupported-scope", "clickedIndexes": [], "submitted": False, "strategy": "dom", "error": str(exc)}
        return dict(value) if isinstance(value, dict) else {"status": "unsupported-scope", "clickedIndexes": [], "submitted": False, "strategy": "dom"}

    def _apply_nested_frame(self, snapshot: Dict[str, Any], indexes: List[int], *, submit: bool) -> Dict[str, Any]:
        scope = str(snapshot.get("scope") or "")
        if not scope.startswith("iframe:"):
            return {"status": "unsupported-scope", "clickedIndexes": [], "submitted": False, "strategy": "frame"}
        try:
            frame_index = int(scope.split(":", 1)[1])
            frames = list(self._sb.find_elements("iframe") or [])
            frame = frames[frame_index]
            images = list(frame.query_selector_all("img") or [])
        except Exception as exc:
            return {"status": "unsupported-scope", "clickedIndexes": [], "submitted": False, "strategy": "frame", "error": str(exc)}

        clicked: List[int] = []
        try:
            for index in indexes:
                image = images[index]
                clicker = getattr(image, "click", None) or getattr(image, "mouse_click", None)
                if not callable(clicker):
                    return {"status": "unsupported-scope", "clickedIndexes": clicked, "submitted": False, "strategy": "frame"}
                clicker(); clicked.append(index)

            submitted = False
            if submit:
                buttons = list(frame.query_selector_all('button,input[type="submit"],[role="button"]') or [])
                for button in buttons:
                    if self._element_visible(button):
                        clicker = getattr(button, "click", None) or getattr(button, "mouse_click", None)
                        if callable(clicker):
                            clicker(); submitted = True; break
            return {"status": "clicked", "clickedIndexes": clicked, "submitted": submitted, "strategy": "frame"}
        except Exception as exc:
            return {"status": "partial", "clickedIndexes": clicked, "submitted": False, "strategy": "frame", "error": str(exc)}

    def _evaluate(self, script: str) -> Any:
        evaluator = getattr(self._sb, "evaluate", None)
        if callable(evaluator):
            return evaluator(script)
        executor = getattr(self._sb, "execute_script", None)
        if callable(executor):
            return executor(f"return {script};")
        raise RuntimeError("No SeleniumBase CDP script evaluator available")

    @staticmethod
    def _clean_indexes(indexes: Iterable[int]) -> List[int]:
        result = sorted({int(index) for index in indexes if int(index) >= 0})
        return result

    @staticmethod
    def _element_visible(element: Any) -> bool:
        try:
            position = element.get_position()
        except Exception:
            return True
        if not isinstance(position, dict):
            return True
        try:
            return float(position.get("width") or 0) >= 24 and float(position.get("height") or 0) >= 24
        except (TypeError, ValueError):
            return False
