from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List


class AuthorizedGridActionExecutor:
    """Apply classifier-selected tile indexes to the current authorized test grid."""

    def __init__(self, seleniumbase_cdp: Any, site_adapter: Any) -> None:
        self._sb = seleniumbase_cdp
        self._site_adapter = site_adapter

    def apply(self, indexes: Iterable[int], *, submit: bool = True) -> Dict[str, Any]:
        state = self._site_adapter.poll()
        selected = self._indexes(indexes, int(state.get("tileCount") or 0))
        if state.get("kind") != "image-grid" or not selected:
            return {"clickedIndexes": [], "submitted": False, "state": state}

        result = self._apply_document(selected, submit)
        if not result["clicked"] and str(state.get("scope") or "").startswith("iframe:"):
            result = self._apply_frame(state, selected, submit)

        return {
            "clickedIndexes": result["clicked"],
            "submitted": result["submitted"],
            "state": self._site_adapter.poll(),
        }

    def _apply_document(self, selected: List[int], submit: bool) -> Dict[str, Any]:
        script = f"""
        (() => {{
          const selected = {json.dumps(selected)};
          const overrides = {json.dumps(self._site_adapter.overrides)};
          const roots = [], seen = new Set();
          const visible = el => {{
            if (!el?.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width >= 24 && r.height >= 24 && s.display !== 'none' && s.visibility !== 'hidden';
          }};
          const walk = root => {{
            if (!root || seen.has(root)) return;
            seen.add(root); roots.push(root);
            for (const el of root.querySelectorAll?.('*') || []) if (el.shadowRoot) walk(el.shadowRoot);
            for (const frame of root.querySelectorAll?.('iframe') || []) {{
              try {{ if (frame.contentDocument) walk(frame.contentDocument); }} catch (_) {{}}
            }}
          }};
          walk(document);

          const groups = [];
          for (const root of roots) {{
            if (overrides.tiles) {{
              const tiles = [...root.querySelectorAll(overrides.tiles)].filter(visible);
              if ([9,16].includes(tiles.length)) groups.push({{root, tiles, preferred:true}});
            }}
            for (const parent of root.querySelectorAll?.('*') || []) {{
              const imgs = [...parent.querySelectorAll('img')].filter(visible);
              if (![9,16].includes(imgs.length)) continue;
              groups.push({{root:parent, tiles:imgs.map(img => img.closest('button,[role="button"],[tabindex],label,li,div') || img), preferred:false}});
            }}
          }}
          groups.sort((a,b) => Number(b.preferred)-Number(a.preferred));
          const group = groups[0];
          if (!group) return {{clicked:[], submitted:false}};

          const clicked = [];
          for (const index of selected) {{
            const tile = group.tiles[index];
            if (!tile) continue;
            tile.scrollIntoView({{block:'center', inline:'center'}});
            tile.click(); clicked.push(index);
          }}

          let submitted = false;
          if ({str(submit).lower()}) {{
            const selector = overrides.submit || 'button[type="submit"],input[type="submit"],button,[role="button"]';
            const button = [...(group.root.parentElement?.querySelectorAll(selector) || [])].filter(visible).find(el => !group.tiles.includes(el));
            if (button) {{ button.click(); submitted = true; }}
          }}
          return {{clicked, submitted}};
        }})()
        """
        value = self._evaluate(script)
        return value if isinstance(value, dict) else {"clicked": [], "submitted": False}

    def _apply_frame(self, state: Dict[str, Any], selected: List[int], submit: bool) -> Dict[str, Any]:
        try:
            index = int(str(state["scope"]).split(":", 1)[1])
            frame = list(self._sb.find_elements("iframe") or [])[index]
            images = list(frame.query_selector_all("img") or [])
        except Exception:
            return {"clicked": [], "submitted": False}

        clicked = []
        for index in selected:
            if index >= len(images):
                continue
            click = getattr(images[index], "mouse_click", None) or getattr(images[index], "click", None)
            if callable(click):
                click(); clicked.append(index)

        submitted = False
        if submit:
            for selector in (self._site_adapter.overrides.get("submit"), 'button[type="submit"]', 'input[type="submit"]', 'button'):
                if not selector:
                    continue
                try:
                    button = frame.query_selector(selector)
                except Exception:
                    button = None
                click = (getattr(button, "mouse_click", None) or getattr(button, "click", None)) if button else None
                if callable(click):
                    click(); submitted = True; break
        return {"clicked": clicked, "submitted": submitted}

    def _evaluate(self, script: str) -> Any:
        evaluate = getattr(self._sb, "evaluate", None)
        return evaluate(script) if callable(evaluate) else self._sb.execute_script(f"return {script};")

    @staticmethod
    def _indexes(values: Iterable[int], count: int) -> List[int]:
        clean = {int(value) for value in values}
        return sorted(index for index in clean if 0 <= index < count)
