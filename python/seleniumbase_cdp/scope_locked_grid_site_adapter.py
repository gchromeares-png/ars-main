from __future__ import annotations

import hashlib
from typing import Any, Dict, Iterable, List, Tuple

from extended_grid_site_adapter import ExtendedGridSiteAdapter, _OOPIF_GRID_SCRIPT
from stable_marks import build_stable_marks, stable_mark_digest


class ScopeLockedGridSiteAdapter(ExtendedGridSiteAdapter):
    """Global grid discovery followed by cheap scope-local revalidation.

    The existing ExtendedGridSiteAdapter remains the only discovery engine. This
    class only owns lifecycle: once a grid is resolved, subsequent validation is
    restricted to that document/frame/OOPIF. A disappearing frame, changed grid
    identity, or changed CDP document epoch invalidates the lock and falls back to
    the existing global discovery on the same poll.
    """

    def __init__(self, seleniumbase_cdp: Any, *, overrides: Dict[str, str] | None = None) -> None:
        super().__init__(seleniumbase_cdp, overrides=overrides)
        self._scope_lock: Dict[str, Any] | None = None

    def poll(self) -> Dict[str, Any]:
        if self._scope_lock is not None:
            local = self._revalidate_locked_scope()
            if self._terminal(local):
                self._scope_lock = None
                return self._with_generation(local)
            if self._matches_lock(local):
                return self._with_generation({**local, "scopeLocked": True})
            self._scope_lock = None

        discovered = self._discover_global()
        if discovered.get("kind") != "image-grid" or not self._candidate_is_plausible(discovered):
            return discovered

        primed = self._prime_scope(discovered)
        candidate = primed if primed is not None and self._same_grid_identity(discovered, primed) else discovered
        lock = self._build_lock(candidate)
        if lock is not None:
            self._scope_lock = lock
            if primed is not None:
                return self._with_generation({**candidate, "scopeLocked": True})
            return {**candidate, "scopeLocked": True}
        return candidate

    def _discover_global(self) -> Dict[str, Any]:
        return super().poll()

    @staticmethod
    def _terminal(state: Dict[str, Any]) -> bool:
        return bool(state.get("complete")) or bool(state.get("failed"))

    def _prime_scope(self, discovered: Dict[str, Any]) -> Dict[str, Any] | None:
        scope = str(discovered.get("scope") or "")
        if scope.startswith("oopif:"):
            path = self._resolve_oopif_path(scope)
            if not path:
                return None
            return self._snapshot_oopif_path(path)
        if scope.startswith("iframe:"):
            try:
                frame_index = int(scope.split(":", 1)[1].split("/", 1)[0])
            except (TypeError, ValueError):
                return None
            return self._snapshot_frame_index(frame_index)
        if scope.startswith("document"):
            return self._snapshot_document_scope(discovered)
        return None

    def _revalidate_locked_scope(self) -> Dict[str, Any]:
        lock = self._scope_lock or {}
        scope = str(lock.get("scope") or "")
        if scope.startswith("oopif:"):
            path = [str(value) for value in lock.get("framePath") or [] if str(value)]
            return self._snapshot_oopif_path(path) if path else self._empty(scope)
        if scope.startswith("iframe:"):
            try:
                frame_index = int(lock.get("frameIndex"))
            except (TypeError, ValueError):
                return self._empty(scope)
            return self._snapshot_frame_index(frame_index)
        if scope.startswith("document"):
            return self._snapshot_document_scope(lock)
        return self._empty(scope or "document")

    def _snapshot_document_scope(self, expected: Dict[str, Any]) -> Dict[str, Any]:
        expected_scope = str(expected.get("scope") or "document")
        candidates = [self._snapshot_document(), self._snapshot_extended_document()]
        terminal: Dict[str, Any] | None = None
        best: Dict[str, Any] | None = None
        best_rank = float("-inf")
        for candidate in candidates:
            if self._terminal(candidate):
                terminal = candidate
            if candidate.get("kind") != "image-grid":
                continue
            if str(candidate.get("scope") or "") != expected_scope:
                continue
            if not self._candidate_is_plausible(candidate):
                continue
            rank = self._candidate_rank(candidate)
            if best is None or rank > best_rank:
                best = candidate
                best_rank = rank
        if best is not None:
            return best
        if terminal is not None:
            return terminal
        return self._empty(expected_scope)

    def _snapshot_frame_index(self, frame_index: int) -> Dict[str, Any]:
        scope = f"iframe:{frame_index}"
        try:
            frames = list(self._sb.find_elements("iframe") or [])
        except Exception:
            return self._empty(scope)
        if frame_index < 0 or frame_index >= len(frames):
            return self._empty(scope)

        frame = frames[frame_index]
        frame_position = self._element_position(frame)
        if not isinstance(frame_position, dict):
            return self._empty(scope)
        try:
            frame_x = float(frame_position.get("x") or 0.0)
            frame_y = float(frame_position.get("y") or 0.0)
            images = [img for img in (frame.query_selector_all("img") or []) if self._element_visible(img)]
        except Exception:
            return self._empty(scope)
        if not (self.MIN_COUNT <= len(images) <= self.MAX_COUNT):
            return self._empty(scope)

        rects = [self._element_position(image) for image in images]
        shape = self._infer_shape(rects)
        if shape is None:
            return self._empty(scope)
        rows, columns = shape
        sources = [self._element_image_source(image) for image in images]
        viewport = self._top_level_viewport()
        raw_marks: List[Dict[str, Any]] = []
        for index, image in enumerate(images):
            local = rects[index]
            if not isinstance(local, dict):
                return self._empty(scope)
            bounds = dict(local)
            try:
                bounds["x"] = float(bounds.get("x") or 0.0) + frame_x
                bounds["y"] = float(bounds.get("y") or 0.0) + frame_y
            except (TypeError, ValueError):
                return self._empty(scope)
            alt = self._element_attribute(image, "alt")
            identity = (
                self._element_attribute(image, "id")
                or self._element_attribute(image, "data-testid")
                or f"slot:{index}"
            )
            raw_marks.append({
                "role": "grid-tile",
                "visualBounds": bounds,
                "confidence": 0.92 if sources[index] else 0.70,
                "structuralKey": f"img|{identity}",
                "semanticSignature": f"grid-tile|{alt}|{sources[index]}",
                "source": sources[index],
                "label": alt,
                "score": index,
            })

        candidate = {
            "kind": "image-grid",
            "scope": scope,
            "score": 82 if all(sources) else 70,
            "rows": rows,
            "columns": columns,
            "tileCount": len(images),
            "instruction": self._frame_descriptor(frame),
            "sources": sources,
            "submitText": "",
            "submitBounds": None,
            "complete": False,
            "failed": False,
            "override": False,
            "viewport": viewport,
            "marks": build_stable_marks(raw_marks, scope=scope, viewport=viewport),
        }
        return candidate if self._candidate_is_plausible(candidate) else self._empty(scope)

    def _resolve_oopif_path(self, scope: str) -> List[str]:
        discover = getattr(self._sb, "ares_oopif_discover", None)
        if not callable(discover):
            return []
        try:
            entries = list(discover() or [])
        except Exception:
            return []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            path = [str(value) for value in entry.get("path") or [] if str(value)]
            if path and "oopif:" + "/".join(path) == scope:
                return path
        return []

    def _snapshot_oopif_path(self, path: Iterable[str]) -> Dict[str, Any]:
        clean_path = [str(value) for value in path if str(value)]
        scope = "oopif:" + "/".join(clean_path)
        evaluate = getattr(self._sb, "ares_oopif_evaluate", None)
        if not clean_path or not callable(evaluate):
            return self._empty(scope or "oopif")
        try:
            evaluated = evaluate(clean_path, _OOPIF_GRID_SCRIPT, [self._overrides])
        except Exception:
            return self._empty(scope)
        if not isinstance(evaluated, dict):
            return self._empty(scope)
        value = evaluated.get("value")
        if not isinstance(value, dict):
            return self._empty(scope)

        metadata = {
            "framePath": clean_path,
            "frameId": str(evaluated.get("frameId") or ""),
            "documentEpoch": int(evaluated.get("documentEpoch") or 0),
            "sessionGeneration": int(evaluated.get("sessionGeneration") or 0),
        }
        if value.get("kind") != "image-grid":
            return {
                **self._empty(scope),
                **metadata,
                "complete": bool(value.get("complete")),
                "failed": bool(value.get("failed")),
            }

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
        return candidate if self._candidate_is_plausible(candidate) else self._empty(scope)

    @classmethod
    def _grid_identity(cls, state: Dict[str, Any]) -> Tuple[Any, ...]:
        marks = [
            mark for mark in state.get("marks") or []
            if isinstance(mark, dict) and mark.get("role") == "grid-tile"
        ]
        mark_identity = tuple(
            (
                str(mark.get("markId") or ""),
                str(mark.get("source") or mark.get("semanticVisualSignature") or ""),
            )
            for mark in marks
        )
        return (
            str(state.get("scope") or ""),
            int(state.get("rows") or 0),
            int(state.get("columns") or 0),
            int(state.get("tileCount") or 0),
            mark_identity,
        )

    @classmethod
    def _same_grid_identity(cls, first: Dict[str, Any], second: Dict[str, Any]) -> bool:
        return first.get("kind") == "image-grid" and second.get("kind") == "image-grid" and cls._grid_identity(first) == cls._grid_identity(second)

    def _build_lock(self, state: Dict[str, Any]) -> Dict[str, Any] | None:
        if state.get("kind") != "image-grid":
            return None
        scope = str(state.get("scope") or "")
        lock: Dict[str, Any] = {
            "scope": scope,
            "identity": self._grid_identity(state),
        }
        if scope.startswith("iframe:"):
            try:
                lock["frameIndex"] = int(scope.split(":", 1)[1].split("/", 1)[0])
            except (TypeError, ValueError):
                return None
        if scope.startswith("oopif:"):
            path = [str(value) for value in state.get("framePath") or [] if str(value)]
            if not path:
                return None
            lock.update({
                "framePath": path,
                "frameId": str(state.get("frameId") or ""),
                "documentEpoch": int(state.get("documentEpoch") or 0),
                "sessionGeneration": int(state.get("sessionGeneration") or 0),
            })
        return lock

    def _matches_lock(self, state: Dict[str, Any]) -> bool:
        lock = self._scope_lock or {}
        if state.get("kind") != "image-grid":
            return False
        if self._grid_identity(state) != lock.get("identity"):
            return False
        if str(lock.get("scope") or "").startswith("oopif:"):
            if [str(value) for value in state.get("framePath") or [] if str(value)] != lock.get("framePath"):
                return False
            if str(state.get("frameId") or "") != str(lock.get("frameId") or ""):
                return False
            if int(state.get("documentEpoch") or 0) != int(lock.get("documentEpoch") or 0):
                return False
            if int(state.get("sessionGeneration") or 0) != int(lock.get("sessionGeneration") or 0):
                return False
        return True

    def _with_generation(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        signature_input = "|".join([
            str(snapshot.get("kind") or "none"),
            str(snapshot.get("scope") or ""),
            str(snapshot.get("tileCount") or 0),
            str(snapshot.get("instruction") or ""),
            str(bool(snapshot.get("complete"))),
            str(bool(snapshot.get("failed"))),
            stable_mark_digest(snapshot.get("marks") or []),
            str(snapshot.get("frameId") or ""),
            str(int(snapshot.get("documentEpoch") or 0)),
            str(int(snapshot.get("sessionGeneration") or 0)),
        ])
        signature = hashlib.sha256(signature_input.encode("utf-8", errors="ignore")).hexdigest()
        if signature != self._last_signature:
            self._generation += 1
            self._last_signature = signature
        return {**snapshot, "generation": self._generation, "signature": signature}
