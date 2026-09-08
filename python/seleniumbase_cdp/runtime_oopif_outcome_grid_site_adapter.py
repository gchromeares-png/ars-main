from __future__ import annotations

from typing import Any, Dict, Iterable

from runtime_oopif_grid_site_adapter import ScopeLockedGridSiteAdapter as _DirectChildrenGridSiteAdapter


_OUTCOME_SCRIPT = r"""
return (() => {
  const visible = el => {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0
      && s.display !== 'none'
      && s.visibility !== 'hidden'
      && Number(s.opacity || 1) > 0;
  };
  const values = [...(document.querySelectorAll?.('strong,b,[role="status"],[role="alert"],p,h1,h2,h3,h4,div,span') || [])]
    .filter(visible)
    .map(el => String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 1200);
  const text = values.join('\n').slice(0, 20000);
  const success = /(?:^|\b)(success|successful|correct|passed|verified|erfolgreich|richtig|bestanden)(?:\b|$)/i.test(text);
  const failure = /(?:^|\b)(failed|failure|incorrect|wrong|error|fehlgeschlagen|falsch|nicht korrekt)(?:\b|$)/i.test(text);
  return {complete: !!success && !failure, failed: !!failure && !success};
})();
"""


class ScopeLockedGridSiteAdapter(_DirectChildrenGridSiteAdapter):
    """Add generic explicit outcome detection inside the already resolved OOPIF."""

    def _snapshot_oopif_path(self, path: Iterable[str]) -> Dict[str, Any]:
        state = super()._snapshot_oopif_path(path)
        if bool(state.get("complete")) or bool(state.get("failed")):
            return state

        clean_path = [str(value) for value in path if str(value)]
        evaluate = getattr(self._sb, "ares_oopif_evaluate", None)
        if not clean_path or not callable(evaluate):
            return state
        try:
            evaluated = evaluate(clean_path, _OUTCOME_SCRIPT, [])
        except Exception:
            return state
        if not isinstance(evaluated, dict):
            return state
        value = evaluated.get("value")
        if not isinstance(value, dict):
            return state
        complete = bool(value.get("complete"))
        failed = bool(value.get("failed"))
        if not complete and not failed:
            return state
        return {**state, "complete": complete, "failed": failed}
