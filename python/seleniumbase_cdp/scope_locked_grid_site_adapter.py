from __future__ import annotations

from typing import Any, Dict, Iterable, List

from scope_locked_grid_site_adapter_base import ScopeLockedGridSiteAdapter as _BaseScopeLockedGridSiteAdapter
from stable_marks import build_stable_marks


BROAD_OOPIF_GRID_SCRIPT = r"""
return (() => {
  const viewport = {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
  const debug = {
    scannedElements: 0,
    visualCount: 0,
    parentCandidates: 0,
    directChildCandidates: 0,
    acceptedCandidates: 0,
    rejections: {},
  };
  const reject = reason => {
    debug.rejections[reason] = Number(debug.rejections[reason] || 0) + 1;
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
  const rectOf = el => {
    const r = el.getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height};
  };
  const selectorFor = el => {
    if (!el) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const testId = el.getAttribute?.('data-testid');
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
    return '';
  };
  const tileFor = visual => visual.closest?.(
    'button,[role="button"],[role="gridcell"],[tabindex],label,li,'
      + '[class*="tile" i],[class*="cell" i],[class*="option" i],[class*="choice" i],'
      + '[class*="square" i],[class*="image" i]'
  ) || visual;
  const visualsIn = root => {
    const direct = [...(root.querySelectorAll?.('img,canvas,svg') || [])].filter(visible);
    const backgrounds = [...(root.querySelectorAll?.('body *') || root.querySelectorAll?.('*') || [])]
      .filter(el => {
        if (!visible(el) || !bgUrl(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width <= Math.max(1000, viewport.width * 0.9)
          && r.height <= Math.max(1000, viewport.height * 0.9);
      });
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
  const shapeOf = tiles => {
    if (tiles.length < 4 || tiles.length > 64) {
      reject('count');
      return null;
    }
    const rects = tiles.map(el => el.getBoundingClientRect());
    const avgW = rects.reduce((a,r) => a+r.width,0) / rects.length;
    const avgH = rects.reduce((a,r) => a+r.height,0) / rects.length;
    if (avgW < 20 || avgH < 20) {
      reject('small');
      return null;
    }
    const rows = clusterCount(
      rects.map(r => r.top + r.height / 2),
      Math.max(6, Math.min(36, avgH * 0.45))
    );
    const columns = clusterCount(
      rects.map(r => r.left + r.width / 2),
      Math.max(6, Math.min(36, avgW * 0.45))
    );
    if (rows < 2 || columns < 2 || rows > 8 || columns > 8) {
      reject('dimensions');
      return null;
    }
    if (rows * columns !== tiles.length) {
      reject('shape-product');
      return null;
    }
    const regular = rects.filter(r =>
      Math.abs(r.width - avgW) <= Math.max(12, avgW * 0.30)
      && Math.abs(r.height - avgH) <= Math.max(12, avgH * 0.30)
    ).length;
    if (regular / tiles.length < 0.82) {
      reject('regularity');
      return null;
    }
    return {rows, columns, regular, avgW, avgH};
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
  const interactive = el => Boolean(el?.matches?.(
    'button,[role="button"],[role="gridcell"],[tabindex],label,li,'
      + '[class*="tile" i],[class*="cell" i],[class*="option" i],[class*="choice" i],'
      + '[class*="square" i]'
  ));

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (parent, rawTiles, origin) => {
    const tiles = [...new Set(rawTiles)].filter(visible);
    if (tiles.length < 4 || tiles.length > 64) return;
    const key = tiles.map(el => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.width)}:${Math.round(r.height)}`;
    }).join('|');
    if (seen.has(key)) return;
    seen.add(key);

    const shape = shapeOf(tiles);
    if (!shape) return;
    const sources = tiles.map(sourceOf);
    const sourceCount = sources.filter(Boolean).length;
    const instructionEl = instructionFor(parent);
    const instruction = text(instructionEl).slice(0, 600);
    const submitEl = submitFor(parent, tiles);
    const submitText = text(submitEl).slice(0, 120);
    const hasActionContext = actionRx.test(instruction + ' ' + submitText);
    const interactiveCount = tiles.filter(interactive).length;

    // Screenshot crops are the canonical visual input later in the pipeline,
    // therefore a structurally strong grid may legitimately have blank DOM sources.
    // To avoid generic layout false positives, blank-source grids still require
    // explicit action context or a majority of tile-like children.
    const majorityInteractive = interactiveCount >= Math.ceil(tiles.length * 0.5);
    if (sourceCount === 0 && !hasActionContext && !majorityInteractive) {
      reject('weak-evidence');
      return;
    }

    const rawMarks = tiles.map((tile, index) => ({
      role:'grid-tile',
      visualBounds:rectOf(tile),
      confidence:sources[index] ? .94 : .78,
      selector:selectorFor(tile),
      structuralKey:['grid-tile',tile.tagName||'',tile.id||'',tile.getAttribute?.('data-testid')||'',`tslot:${index}`].join('|'),
      semanticSignature:['grid-tile',text(tile).slice(0,160),sources[index]].join('|'),
      source:sources[index],
      label:text(tile).slice(0,160),
      score:index,
    }));
    let score = 72;
    score += Math.round(14 * sourceCount / tiles.length);
    score += Math.round(10 * shape.regular / tiles.length);
    if (hasActionContext) score += 8;
    else if (instruction) score += 1;
    if (submitEl) score += 3;
    if (origin === 'direct-children') score += 4;
    if (shape.avgW >= 64 && shape.avgH >= 64) score += 4;
    candidates.push({
      kind:'ymage-grid',
      scope:'oopif',
      origin,
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
      debug:{oregin,sourceCount,interactiveCount,hasActionContext},
    });
    debug.acceptedCandidates += 1;
  };

  const visuals = visualsIn(document);
  debug.visualCount = visuals.length;
  const parents = new Set();
  for (const visual of visuals) {
    let node = tileFor(visual);
    for (let depth=0; node && depth<6; depth++, node=node.parentElement) {
      if (node.parentElement) parents.add(node.parentElement);
    }
  }
  debug.parentCandidates = parents.size;
  for (const parent of parents) {
    pushCandidate(parent, visualsIn(parent).map(tileFor), 'visual-ancestor');
  }

  // Explicitly scan regular visible direct-child layouts. This is intentionally
  // tagname/class-agnostic: real grids often use plain DIVs children with pyels
  // painted by pseudo elements, inline styles, shadow DOM, or other rendering layers.
  const allElements = [...(document.querySelectorAll?.('body *') || [])];
  debug.scannedElements = allElements.length;
  for (const parent of allElements.slice(0,4000)) {
    if (!visible(parent)) continue;
    const children = [...parent.children].filter(child => visible(child));
    if (children.length < 4 || children.length > 64) continue;
    debug.directChildCandidates += 1;
    pushCandidate(parent, children, 'direct-children');
  }

  candidates.sort((a,b) => b.score - a.score);
  const best = candidates[0] || null;
  if (best) {
    best.debug = {...debug, ...best.debug};
    return best;
  }
  return {
    kind:'none',scope: 'oopif',score:0,rows:0,columns:0,tileCount:0,
    instruction:'',sources:[],submitText:'',submitBounds:null,complete:false,failed:false,
    override:false,rawMarks:[],viewport,debug
  };
})();
"""


class ScopeLockedGridSiteAdapter(_BaseScopeLockedGridSiteAdapter):
    """Broad OOPIF grid discovery layered on the current scope-lock base."""

    def _discover_global(self) -> Dict[str, Any]:
        producers = (
            self._snapshot_document,
            self._snapshot_extended_document,
            self._snapshot_nested_frames,
            self._snapshot_extended_frames,
            self._snapshot_oopif_frames,
        )
        debug: List[Dict[str, Any]] = []
        outcome: Dict[str, Any] | None = None
        rejected: Dict[str, Any] | None = None
        best: Dict[str, Any] | None = None
        best_rank = float("-inf")

        try:
            frames = list(self._sb.find_elements("iframe") or [])
            debug.append({"producer": "iframe-enumeration", "count": len(frames)})
        except Exception as exc:
            debug.append({"producer": "iframe-enumeration", "error": str(exc)[:500]})

        for producer in producers:
            name = getattr(producer, "__name__", producer.__class__.__name__)
            try:
                snapshot = producer()
            except Exception as exc:
                debug.append({"producer": name, "error": str(exc)[:500]})
                continue
            item: Dict[str, Any] = {
                "producer": name,
                "kind": str(snapshot.get("kind") or "none"),
                "scope": str(snapshot.get("scope") or ""),
                "score": int(snapshot.get("score") or 0),
                "tileCount": int(snapshot.get("tileCount") or 0),
                "instruction": str(snapshot.get("instruction") or "")[:240],
                "framePath": [str(value) for value in snapshot.get("framePath") or [] if str(value)],
            }
            if snapshot.get("oopifDebug"):
                item["oopifDebug"] = snapshot.get("oopifDebug")
            debug.append(item)
            if snapshot.get("kind") == "none":
                if self._terminal(snapshot):
                    outcome = snapshot
                continue
            if not self._candidate_is_plausible(snapshot):
                rejected = snapshot
                continue
            rank = self._candidate_rank(snapshot)
            if best is None or rank > best_rank:
                best = snapshot
                best_rank = rank

        discover = getattr(self._sb, "ares_oopif_discover", None)
        if callable(discover):
            try:
                entries = [entry for entry in (discover() or []) if isinstance(entry, dict)]
                debug.append({
                    "producer": "ares_oopif_discover",
                    "count": len(entries),
                    "paths": [[str(value) for value in entry.get("path") or [] if str(value)] for entry in entries[:16]],
                })
            except Exception as exc:
                debug.append({"producer": "ares_oopif_discover", "error": str(exc)[:500]})
        else:
            debug.append({"producer": "ares_oopif_discover", "available": False})

        if outcome is not None:
            return self._with_generation({**outcome, "discoveryDebug": debug})
        if best is not None:
            return self._with_generation({**best, "discoveryDebug": debug})
        scope = str((rejected or {}).get("scope") or "document")
        payload = {**self._empty(scope), "discoveryDebug": debug}
        if rejected and rejected.get("oopifDebug"):
            payload["oopifDebug"] = rejected.get("oopifDebug")
        return self._with_generation(payload)

    def _snapshot_oopif_frames(self) -> Dict[str, Any]:
        discover = getattr(self._sb, "ares_oopif_discover", None)
        if not callable(discover):
            return {$�PЀL@