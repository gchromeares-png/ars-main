from __future__ import annotations

from typing import Any, Dict, Iterable, List

from scope_locked_grid_site_adapter import ScopeLockedGridSiteAdapter as _BaseScopeLockedGridSiteAdapter
from stable_marks import build_stable_marks


_DIRECT_CHILDREN_OOPIF_GRID_SCRIPT = r"""
return (() => {
  const viewport = {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
  const visible = el => {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width >= 20 && r.height >= 20
      && r.right > 0 && r.bottom > 0
      && r.left < viewport.width && r.top < viewport.height
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
  const bgUrl = el => {
    if (!el || !visible(el)) return '';
    const bg = getComputedStyle(el).backgroundImage || '';
    const match = bg.match(/url\(["']?(.*?)["']?\)/i);
    return match?.[1] || '';
  };
  const sourceOf = tile => {
    const img = tile?.matches?.('img') ? tile : tile?.querySelector?.('img');
    if (img) {
      return img.currentSrc
        || img.src
        || img.getAttribute?.('src')
        || img.getAttribute?.('data-src')
        || img.getAttribute?.('data-lazy-src')
        || '';
    }
    const canvas = tile?.matches?.('canvas') ? tile : tile?.querySelector?.('canvas');
    if (canvas) {
      try { return canvas.toDataURL?.('image/png') || ''; } catch (_) { return ''; }
    }
    return bgUrl(tile);
  };
  const clusterCount = (values, tolerance) => {
    const sorted = [...values].sort((a,b) => a-b);
    const groups = [];
    for (const value of sorted) {
      const last = groups[groups.length - 1];
      if (!last || Math.abs(value - last.mean) > tolerance) {
        groups.push({mean:value,count:1});
      } else {
        last.mean = (last.mean * last.count + value) / (last.count + 1);
        last.count += 1;
      }
    }
    return groups.length;
  };
  const shapeOf = tiles => {
    if (tiles.length < 4 || tiles.length > 64) return null;
    const rects = tiles.map(el => el.getBoundingClientRect());
    const avgW = rects.reduce((a,r) => a+r.width,0) / rects.length;
    const avgH = rects.reduce((a,r) => a+r.height,0) / rects.length;
    if (avgW < 20 || avgH < 20) return null;
    const rows = clusterCount(
      rects.map(r => r.top + r.height / 2),
      Math.max(6, Math.min(36, avgH * 0.45))
    );
    const columns = clusterCount(
      rects.map(r => r.left + r.width / 2),
      Math.max(6, Math.min(36, avgW * 0.45))
    );
    if (rows < 2 || columns < 2 || rows > 8 || columns > 8) return null;
    if (rows * columns !== tiles.length) return null;
    const regular = rects.filter(r =>
      Math.abs(r.width - avgW) <= Math.max(12, avgW * 0.30)
      && Math.abs(r.height - avgH) <= Math.max(12, avgH * 0.30)
    ).length;
    if (regular / tiles.length < 0.82) return null;
    return {rows, columns, regular};
  };
  const actionRx = /(select|click|choose|mark|pick|tap|verify|verification|continue|confirm|wähl|waehl|auswähl|auswaehl|klick|anklick|markier|prüf|pruef|bestät|bestaet|weiter)/i;
  const instructionFor = parent => {
    const nearby = [
      parent?.previousElementSibling,
      parent?.parentElement?.previousElementSibling,
      ...[...(parent?.parentElement?.querySelectorAll?.(
        'h1,h2,h3,h4,p,[class*="instruction" i],[class*="prompt" i],[class*="question" i]'
      ) || [])],
      ...[...(document.querySelectorAll?.(
        'h1,h2,h3,h4,p,[class*="instruction" i],[class*="prompt" i],[class*="question" i]'
      ) || [])],
    ].filter(el => el && visible(el));
    return nearby.find(el => actionRx.test(text(el))) || nearby[0] || null;
  };
  const submitFor = (parent, tiles) => [...(parent?.parentElement?.querySelectorAll?.(
    'button[type="submit"],input[type="submit"],button,[role="button"]'
  ) || [])].find(el => visible(el) && !tiles.includes(el)) || null;

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (parent, rawTiles) => {
    const tiles = [...new Set(rawTiles)].filter(visible);
    const shape = shapeOf(tiles);
    if (!shape) return;
    const key = tiles.map(el => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.width)}:${Math.round(r.height)}`;
    }).join('|');
    if (seen.has(key)) return;
    seen.add(key);

    const sources = tiles.map(sourceOf);
    const sourceCount = sources.filter(Boolean).length;
    const instruction = text(instructionFor(parent)).slice(0, 600);
    const submitEl = submitFor(parent, tiles);
    const submitText = text(submitEl).slice(0, 120);
    const hasActionContext = actionRx.test(instruction + ' ' + submitText);

    // The runtime crops pixels from the screenshot later, so DOM sources may be blank.
    // Blank-source candidates are accepted only when the iframe itself exposes clear
    // action language, which keeps generic page layouts from being treated as grids.
    if (sourceCount === 0 && !hasActionContext) return;
    if (sourceCount > 0 && sourceCount < Math.ceil(tiles.length * 0.5) && !hasActionContext) return;

    const rawMarks = tiles.map((tile, index) => ({
      role:'grid-tile',
      visualBounds:rectOf(tile),
      confidence:sources[index] ? .92 : .76,
      selector:tile.id ? '#' + CSS.escape(tile.id) : '',
      structuralKey:['grid-tile',tile.tagName||'',tile.id||'',tile.getAttribute?.('data-testid')||'',`slot:${index}`].join('|'),
      semanticSignature:['grid-tile',text(tile).slice(0,160),sources[index]].join('|'),
      source:sources[index],
      label:text(tile).slice(0,160),
      score:index,
    }));
    let score = 76 + Math.round(10 * shape.regular / tiles.length);
    score += Math.round(10 * sourceCount / tiles.length);
    if (hasActionContext) score += 8;
    if (submitEl) score += 3;
    score += 4; // direct-children preference
    candidates.push({
      kind:'image-grid',
      scope:'oopif',
      origin:'direct-children',
      score,
      rows:shape.rows,
      columns:shape.columns,
      tileCount:tiles.length,
      instruction,
      sources,
      submitText,
      submitBounds:submitEl ? rectOf(submitEl) : null,
      complete:false,
      failed:false,
      override:false,
      rawMarks,
      viewport,
      debug:{sourceCount,hasActionContext},
    });
  };

  for (const parent of [...(document.querySelectorAll?.('body *') || [])].slice(0,4000)) {
    if (!visible(parent)) continue;
    const children = [...parent.children].filter(visible);
    if (children.length < 4 || children.length > 64) continue;
    pushCandidate(parent, children);
  }

  candidates.sort((a,b) => b.score - a.score);
  return candidates[0] || {
    kind:'none',scope:'oopif',score:0,rows:0,columns:0,tileCount:0,
    instruction:'',sources:[],submitText:'',submitBounds:null,
    complete:false,failed:false,override:false,rawMarks:[],viewport,
    debug:{origin:'direct-children',candidateCount:0},
  };
})();
"""


class ScopeLockedGridSiteAdapter(_BaseScopeLockedGridSiteAdapter):
    """Add an OOPIF-only direct-child geometry fallback to the proven base adapter."""

    def _snapshot_oopif_path(self, path: Iterable[str]) -> Dict[str, Any]:
        primary = super()._snapshot_oopif_path(path)
        if primary.get("kind") == "image-grid" or bool(primary.get("complete")) or bool(primary.get("failed")):
            return primary

        clean_path = [str(value) for value in path if str(value)]
        scope = "oopif:" + "/".join(clean_path)
        evaluate = getattr(self._sb, "ares_oopif_evaluate", None)
        if not clean_path or not callable(evaluate):
            return primary

        try:
            evaluated = evaluate(clean_path, _DIRECT_CHILDREN_OOPIF_GRID_SCRIPT, [])
        except Exception as exc:
            return {**primary, "oopifDebug": {"fallback": "direct-children", "error": str(exc)[:500]}}
        if not isinstance(evaluated, dict) or not isinstance(evaluated.get("value"), dict):
            return {**primary, "oopifDebug": {"fallback": "direct-children", "reason": "invalid-evaluate-result"}}

        value = evaluated["value"]
        debug = value.get("debug") if isinstance(value.get("debug"), dict) else {}
        metadata = {
            "framePath": clean_path,
            "frameId": str(evaluated.get("frameId") or ""),
            "documentEpoch": int(evaluated.get("documentEpoch") or 0),
            "sessionGeneration": int(evaluated.get("sessionGeneration") or 0),
            "oopifDebug": {"fallback": "direct-children", **debug},
        }
        if value.get("kind") != "image-grid":
            return {**primary, **metadata}

        try:
            offset_x = float(evaluated.get("offsetX") or 0.0)
            offset_y = float(evaluated.get("offsetY") or 0.0)
        except (TypeError, ValueError):
            offset_x = offset_y = 0.0

        viewport = self._top_level_viewport()
        raw_marks: List[Dict[str, Any]] = []
        for raw in value.get("rawMarks") or []:
            if not isinstance(raw, dict):
                continue
            item = dict(raw)
            bounds = item.get("visualBounds")
            if isinstance(bounds, dict):
                adjusted = dict(bounds)
                try:
                    adjusted["x"] = float(adjusted.get("x") or 0.0) + offset_x
                    adjusted["y"] = float(adjusted.get("y") or 0.0) + offset_y
                except (TypeError, ValueError):
                    continue
                item["visualBounds"] = adjusted
            raw_marks.append(item)

        candidate: Dict[str, Any] = {
            "kind": "image-grid",
            "scope": scope,
            "origin": "direct-children",
            "score": int(value.get("score") or 0),
            "rows": int(value.get("rows") or 0),
            "columns": int(value.get("columns") or 0),
            "tileCount": int(value.get("tileCount") or 0),
            "instruction": str(value.get("instruction") or ""),
            "sources": [str(source) for source in value.get("sources") or []],
            "submitText": str(value.get("submitText") or ""),
            "complete": bool(value.get("complete")),
            "failed": bool(value.get("failed")),
            "override": False,
            "viewport": viewport,
            "marks": build_stable_marks(raw_marks, scope=scope, viewport=viewport),
            **metadata,
        }
        submit_bounds = value.get("submitBounds")
        if isinstance(submit_bounds, dict):
            try:
                candidate["submitBounds"] = {
                    "x": float(submit_bounds.get("x") or 0.0) + offset_x,
                    "y": float(submit_bounds.get("y") or 0.0) + offset_y,
                    "width": float(submit_bounds.get("width") or 0.0),
                    "height": float(submit_bounds.get("height") or 0.0),
                }
            except (TypeError, ValueError):
                candidate["submitBounds"] = None
        else:
            candidate["submitBounds"] = None

        return candidate if self._candidate_is_plausible(candidate) else {**primary, **metadata}
