from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional


@dataclass(frozen=True)
class SiteSelectorOverride:
    name: str
    root: str
    target: str
    tiles: str
    image: str = "img"
    submit: str = ""
    complete: str = ""
    failed: str = ""


class UniversityDemoSiteAdapter:
    """Map an authorized university test page into one neutral grid schema.

    Detection is intentionally provider-neutral. It first tries explicit selector
    overrides supplied for a known test-page structure, then falls back to a
    conservative generic DOM heuristic for ordinary image-grid exercises.
    """

    def __init__(self, seleniumbase_cdp: Any, overrides: Optional[Iterable[SiteSelectorOverride]] = None) -> None:
        self._sb = seleniumbase_cdp
        self._overrides = list(overrides or [])

    def snapshot(self) -> Dict[str, Any]:
        for override in self._overrides:
            snapshot = self._snapshot_override(override)
            if snapshot.get("matched"):
                return snapshot
        return self._snapshot_generic()

    def apply_selection(self, snapshot: Dict[str, Any], indexes: List[int]) -> bool:
        root_selector = str(snapshot.get("rootSelector") or "")
        tile_selector = str(snapshot.get("tileSelector") or "")
        submit_selector = str(snapshot.get("submitSelector") or "")
        if not root_selector or not tile_selector:
            return False
        script = r"""
        const rootSelector = arguments[0];
        const tileSelector = arguments[1];
        const submitSelector = arguments[2];
        const indexes = arguments[3];
        const root = document.querySelector(rootSelector);
        if (!root) return false;
        const tiles = [...root.querySelectorAll(tileSelector)];
        indexes.forEach((index) => {
          const tile = tiles[index];
          if (tile && tile.getAttribute('aria-pressed') !== 'true' && tile.getAttribute('aria-selected') !== 'true') {
            tile.click();
          }
        });
        if (submitSelector) {
          const submit = root.querySelector(submitSelector) || document.querySelector(submitSelector);
          if (submit) submit.click();
        }
        return true;
        """
        return bool(self._sb.evaluate(script, root_selector, tile_selector, submit_selector, indexes))

    def completion_state(self, snapshot: Dict[str, Any]) -> str:
        complete_selector = str(snapshot.get("completeSelector") or "")
        failed_selector = str(snapshot.get("failedSelector") or "")
        if not complete_selector and not failed_selector:
            return "pending"
        script = r"""
        const completeSelector = arguments[0];
        const failedSelector = arguments[1];
        if (completeSelector && document.querySelector(completeSelector)) return 'complete';
        if (failedSelector && document.querySelector(failedSelector)) return 'failed';
        return 'pending';
        """
        return str(self._sb.evaluate(script, complete_selector, failed_selector) or "pending")

    def _snapshot_override(self, override: SiteSelectorOverride) -> Dict[str, Any]:
        script = r"""
        const cfg = arguments[0];
        const root = document.querySelector(cfg.root);
        if (!root) return { matched: false };
        const tiles = [...root.querySelectorAll(cfg.tiles)];
        if (!tiles.length) return { matched: false };
        const targetNode = root.querySelector(cfg.target) || document.querySelector(cfg.target);
        const sources = tiles.map((tile) => {
          const image = tile.matches(cfg.image) ? tile : tile.querySelector(cfg.image);
          if (!image) return '';
          return image.currentSrc || image.src || image.getAttribute('src') || '';
        });
        return {
          matched: true,
          adapter: cfg.name,
          target: targetNode ? (targetNode.textContent || '').trim() : '',
          sources,
          generation: sources.join('|'),
          rootSelector: cfg.root,
          tileSelector: cfg.tiles,
          submitSelector: cfg.submit || '',
          completeSelector: cfg.complete || '',
          failedSelector: cfg.failed || ''
        };
        """
        value = self._sb.evaluate(script, override.__dict__)
        return dict(value) if isinstance(value, dict) else {"matched": False}

    def _snapshot_generic(self) -> Dict[str, Any]:
        script = r"""
        const candidates = [...document.querySelectorAll('section, article, form, main, div')];
        const scored = [];
        for (const root of candidates) {
          const imgs = [...root.querySelectorAll('img')].filter((img) => {
            const r = img.getBoundingClientRect();
            return r.width >= 40 && r.height >= 40 && r.width / r.height > 0.6 && r.width / r.height < 1.7;
          });
          if (imgs.length !== 9 && imgs.length !== 16) continue;
          const clickable = imgs.map((img) => img.closest('button,[role="button"],[role="option"],label,a') || img.parentElement).filter(Boolean);
          if (clickable.length !== imgs.length) continue;
          scored.push({ root, imgs, clickable, score: imgs.length });
        }
        if (!scored.length) return { matched: false };
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];
        const root = best.root;
        const heading = root.querySelector('h1,h2,h3,h4,legend,p,[role="heading"]') || root.previousElementSibling;
        const marker = 'ares-auto-grid-' + Math.random().toString(36).slice(2);
        root.setAttribute('data-ares-auto-grid-id', marker);
        best.clickable.forEach((el, i) => el.setAttribute('data-ares-auto-grid-tile', String(i)));
        const submit = root.querySelector('button[type="submit"],button:not([disabled]),[role="button"]');
        if (submit) submit.setAttribute('data-ares-auto-grid-submit', 'true');
        return {
          matched: true,
          adapter: 'generic-image-grid',
          target: heading ? (heading.textContent || '').trim() : '',
          sources: best.imgs.map((img) => img.currentSrc || img.src || ''),
          generation: best.imgs.map((img) => img.currentSrc || img.src || '').join('|'),
          rootSelector: '[data-ares-auto-grid-id="' + marker + '"]',
          tileSelector: '[data-ares-auto-grid-tile]',
          submitSelector: submit ? '[data-ares-auto-grid-submit="true"]' : '',
          completeSelector: '',
          failedSelector: ''
        };
        """
        value = self._sb.evaluate(script)
        return dict(value) if isinstance(value, dict) else {"matched": False}
