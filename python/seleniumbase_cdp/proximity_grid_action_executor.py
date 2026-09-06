from __future__ import annotations

import json
import time
from typing import Any, Dict, Iterable, List, Tuple

from authorized_grid_action_executor import AuthorizedGridActionExecutor
from interaction_policy import InteractionPolicy


_CONFIRM_TEXT = (
    "ok",
    "yes",
    "ja",
    "verify",
    "bestätigen",
    "bestaetigen",
    "weiter",
    "continue",
    "accept",
    "accept all",
    "alles akzeptieren",
    "akzeptieren",
    "allow",
    "zulassen",
)


class ProximityGridActionExecutor(AuthorizedGridActionExecutor):
    """Click selected grid tiles in a deterministic nearest-neighbour order."""

    def __init__(self, seleniumbase_cdp: Any, site_adapter: Any, policy: InteractionPolicy | None = None) -> None:
        super().__init__(seleniumbase_cdp, site_adapter)
        self._policy = policy or InteractionPolicy()

    def apply(self, indexes: Iterable[int], *, submit: bool = True) -> Dict[str, Any]:
        state = self._site_adapter.poll()
        selected = self._ordered_indexes(
            state,
            self._clean_indexes(indexes, int(state.get("tileCount") or 0)),
        )
        result = self._apply_state(state, selected, submit=submit)
        result["clickOrder"] = list(result.get("clickedIndexes") or selected)
        return result

    def apply_marks(self, mark_ids: Iterable[str], *, submit: bool = True) -> Dict[str, Any]:
        state = self._site_adapter.poll()
        requested = {str(value) for value in mark_ids if str(value)}
        marks = [
            mark for mark in state.get("marks") or []
            if isinstance(mark, dict) and mark.get("role") == "grid-tile"
        ]
        selected = [
            index for index, mark in enumerate(marks)
            if str(mark.get("markId") or "") in requested
        ]
        selected = self._ordered_indexes(state, selected)
        result = self._apply_state(state, selected, submit=submit)

        clicked_order = [int(value) for value in result.get("clickedIndexes") or []]
        result["requestedMarkIds"] = sorted(requested)
        result["clickedMarkIds"] = [
            str(marks[index].get("markId") or "")
            for index in clicked_order
            if 0 <= index < len(marks) and marks[index].get("markId")
        ]
        result["clickOrder"] = clicked_order
        return result

    def _apply_document(self, selected: List[int], submit: bool) -> Dict[str, Any]:
        clicked: List[int] = []
        for position, index in enumerate(selected):
            if self._document_click(index):
                clicked.append(index)
            if position < len(selected) - 1:
                self._sleep_between_clicks()

        submitted = False
        if submit and clicked:
            delay = self._policy.grid_submit_delay_seconds
            if delay > 0:
                time.sleep(delay)
            submitted = self._document_submit()
        return {"clicked": clicked, "submitted": submitted}

    def _apply_frame(self, state: Dict[str, Any], selected: List[int], submit: bool) -> Dict[str, Any]:
        try:
            frame_index = int(str(state["scope"]).split(":", 1)[1])
            frame = list(self._sb.find_elements("iframe") or [])[frame_index]
            images = list(frame.query_selector_all("img") or [])
        except Exception:
            return {"clicked": [], "submitted": False}

        clicked: List[int] = []
        for position, index in enumerate(selected):
            if index >= len(images):
                continue
            click = getattr(images[index], "mouse_click", None)
            if callable(click):
                click()
                clicked.append(index)
            if position < len(selected) - 1:
                self._sleep_between_clicks()

        submitted = False
        if submit and clicked:
            delay = self._policy.grid_submit_delay_seconds
            if delay > 0:
                time.sleep(delay)
            submitted = self._click_marked_confirmation(frame=frame)
        return {"clicked": clicked, "submitted": submitted}

    def _document_click(self, index: int) -> bool:
        marker = f"ares-grid-target-{int(index)}"
        action = f"""
          const tile = group.tiles[{int(index)}];
          if (!tile) return false;
          tile.scrollIntoView({{block:'center', inline:'center'}});
          tile.setAttribute('data-ares-cdp-target', {json.dumps(marker)});
          return true;
        """
        try:
            if not bool(self._evaluate(self._document_group_script(action))):
                return False
            return self._click_marked(marker)
        except Exception:
            return False
        finally:
            self._clear_marker(marker)

    def _document_submit(self) -> bool:
        overrides = getattr(self._site_adapter, "_overrides", {})
        selector = json.dumps(overrides.get("submit") or 'button[type="submit"],input[type="submit"],button,[role="button"]')
        accepted = json.dumps(list(_CONFIRM_TEXT))
        marker = "ares-grid-submit"
        action = f"""
          const selector = {selector};
          const accepted = {accepted};
          const norm = value => String(value || '').trim().toLowerCase().replace(/\\s+/g, ' ');
          const candidates = [...(group.root.parentElement?.querySelectorAll(selector) || [])]
            .filter(el => visible(el) && !group.tiles.includes(el));
          let button = candidates.find(el => {{
            const text = norm(el.innerText || el.textContent || el.value || el.getAttribute('aria-label'));
            return accepted.includes(text);
          }});
          if (!button && overrides.submit) button = candidates[0];
          if (!button) return false;
          button.scrollIntoView({{block:'center', inline:'center'}});
          button.setAttribute('data-ares-cdp-target', {json.dumps(marker)});
          return true;
        """
        try:
            if not bool(self._evaluate(self._document_group_script(action))):
                return False
            return self._click_marked(marker)
        except Exception:
            return False
        finally:
            self._clear_marker(marker)

    def _click_marked_confirmation(self, frame: Any = None) -> bool:
        accepted = set(_CONFIRM_TEXT)
        selectors = ('button[type="submit"]', 'input[type="submit"]', 'button', '[role="button"]')
        roots = [frame] if frame is not None else [getattr(self._sb, "cdp", None)]
        for root in roots:
            if root is None:
                continue
            for selector in selectors:
                try:
                    elements = list(root.find_elements(selector) or []) if hasattr(root, "find_elements") else list(root.query_selector_all(selector) or [])
                except Exception:
                    elements = []
                for element in elements:
                    text = self._element_text(element)
                    if text not in accepted:
                        continue
                    click = getattr(element, "mouse_click", None)
                    if callable(click):
                        click()
                        return True
        return False

    def _click_marked(self, marker: str) -> bool:
        selector = f'[data-ares-cdp-target="{marker}"]'
        cdp = getattr(self._sb, "cdp", None)
        if cdp is not None:
            try:
                elements = list(cdp.find_elements(selector) or [])
            except Exception:
                elements = []
            for element in elements:
                click = getattr(element, "mouse_click", None)
                if callable(click):
                    click()
                    return True
            try:
                frames = list(cdp.find_elements("iframe") or [])
            except Exception:
                frames = []
            for frame in frames:
                try:
                    element = frame.query_selector(selector)
                except Exception:
                    element = None
                click = getattr(element, "mouse_click", None) if element is not None else None
                if callable(click):
                    click()
                    return True
        return False

    def _clear_marker(self, marker: str) -> None:
        try:
            self._evaluate(
                f"""(() => {{
                  const wanted = {json.dumps(marker)};
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
                  for (const root of roots) for (const el of root.querySelectorAll?.('[data-ares-cdp-target]') || [])
                    if (el.getAttribute('data-ares-cdp-target') === wanted) el.removeAttribute('data-ares-cdp-target');
                  return true;
                }})()"""
            )
        except Exception:
            pass

    @staticmethod
    def _element_text(element: Any) -> str:
        for name in ("text", "text_content"):
            try:
                value = getattr(element, name, "")
                if callable(value):
                    value = value()
                text = str(value or "").strip().lower()
                if text:
                    return " ".join(text.split())
            except Exception:
                pass
        for attr in ("value", "aria-label"):
            try:
                getter = getattr(element, "get_attribute", None)
                value = getter(attr) if callable(getter) else ""
                text = str(value or "").strip().lower()
                if text:
                    return " ".join(text.split())
            except Exception:
                pass
        return ""

    def _document_group_script(self, action: str) -> str:
        overrides = getattr(self._site_adapter, "_overrides", {})
        return f"""
        (() => {{
          const overrides = {json.dumps(overrides)};
          const supported = count => count >= 4 && count <= 64;
          const roots = [], seen = new Set();
          const visible = el => {{
            if (!el?.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width >= 20 && r.height >= 20 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
          }};
          const bgUrl = el => {{
            if (!el || !visible(el)) return '';
            const bg = getComputedStyle(el).backgroundImage || '';
            const match = bg.match(/url\\(["']?(.*?)["']?\\)/i);
            return match?.[1] || '';
          }};
          const tileFor = visual => visual.closest?.('button,[role="button"],[tabindex],label,li,[class*="tile" i],[class*="cell" i]') || visual;
          const visualsIn = root => {{
            const items = [...(root.querySelectorAll?.('img,canvas') || [])].filter(visible);
            const backgrounds = [...(root.querySelectorAll?.('button,[role="button"],[tabindex],label,li,[class*="tile" i],[class*="cell" i],[class*="image" i]') || [])]
              .filter(el => visible(el) && bgUrl(el));
            return [...new Set([...items, ...backgrounds])];
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
              if (supported(tiles.length)) groups.push({{root:overrides.root ? root.querySelector(overrides.root) || root : root, tiles, preferred:true}});
            }}
            if (!overrides.tiles) {{
              const parents = new Set();
              for (const visual of visualsIn(root)) {{
                let node = tileFor(visual);
                for (let depth=0; node && depth<5; depth++, node=node.parentElement) if (node.parentElement) parents.add(node.parentElement);
              }}
              for (const parent of parents) {{
                const tiles = [...new Set(visualsIn(parent).map(tileFor))].filter(visible);
                if (!supported(tiles.length)) continue;
                groups.push({{root:parent, tiles, preferred:false}});
              }}
            }}
          }}
          groups.sort((a,b) => Number(b.preferred)-Number(a.preferred));
          const group = groups[0];
          if (!group) return false;
          {action}
        }})()
        """

    def _sleep_between_clicks(self) -> None:
        delay = self._policy.grid_click_delay_seconds
        if delay > 0:
            time.sleep(delay)

    @staticmethod
    def _indexes(values: Iterable[int], count: int) -> List[int]:
        result: List[int] = []
        seen = set()
        for value in values:
            try:
                index = int(value)
            except (TypeError, ValueError):
                continue
            if 0 <= index < count and index not in seen:
                seen.add(index)
                result.append(index)
        return result

    @staticmethod
    def _clean_indexes(values: Iterable[int], count: int) -> List[int]:
        clean = set()
        for value in values:
            try:
                index = int(value)
            except (TypeError, ValueError):
                continue
            if 0 <= index < count:
                clean.add(index)
        return sorted(clean)

    @classmethod
    def _ordered_indexes(cls, state: Dict[str, Any], selected: List[int]) -> List[int]:
        if len(selected) <= 1:
            return list(selected)

        marks = [
            mark for mark in state.get("marks") or []
            if isinstance(mark, dict) and mark.get("role") == "grid-tile"
        ]
        centers: Dict[int, Tuple[float, float]] = {}
        for index in selected:
            if not (0 <= index < len(marks)):
                continue
            bounds = marks[index].get("visualBounds")
            if not isinstance(bounds, dict):
                continue
            try:
                x = float(bounds.get("x") or 0.0)
                y = float(bounds.get("y") or 0.0)
                width = float(bounds.get("width") or 0.0)
                height = float(bounds.get("height") or 0.0)
            except (TypeError, ValueError):
                continue
            if width <= 0 or height <= 0:
                continue
            centers[index] = (x + width / 2.0, y + height / 2.0)

        if len(centers) != len(selected):
            return list(selected)

        remaining = set(selected)
        current = min(remaining, key=lambda index: (centers[index][1], centers[index][0], index))
        order = [current]
        remaining.remove(current)

        while remaining:
            cx, cy = centers[current]
            current = min(
                remaining,
                key=lambda index: (
                    (centers[index][0] - cx) ** 2 + (centers[index][1] - cy) ** 2,
                    centers[index][1],
                    centers[index][0],
                    index,
                ),
            )
            order.append(current)
            remaining.remove(current)

        return order
