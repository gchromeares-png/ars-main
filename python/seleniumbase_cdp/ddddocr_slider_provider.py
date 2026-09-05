from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Dict, Tuple


class DdddOcrSliderProvider:
    """Optional local slider-image matcher.

    The provider is deliberately lazy: ARES does not require ddddocr to start.
    When ddddocr is installed, matching is available automatically without a
    feature flag. SeleniumBase remains the only browser/screenshot executor.
    """

    def __init__(self, seleniumbase_cdp: Any, *, profile_dir: str | Path | None = None) -> None:
        self._sb = seleniumbase_cdp
        self._profile_dir = Path(profile_dir).expanduser().resolve() if profile_dir else None
        self._matcher: Any | None = None
        self._import_failed = False

    def available(self) -> bool:
        return self._load_matcher() is not None

    def ground(self, state: Dict[str, Any]) -> Dict[str, Any] | None:
        if state.get("kind") != "slider" or str(state.get("orientation") or "horizontal") == "vertical":
            return None
        matcher = self._load_matcher()
        if matcher is None:
            return None

        assets = self._discover_assets(state)
        if not assets:
            return None
        target_selector, background_selector = assets

        target_path = self._capture(target_selector, "ddddocr-slider-target.png")
        background_path = self._capture(background_selector, "ddddocr-slider-background.png")
        if target_path is None or background_path is None:
            self._clear_asset_marks()
            return None

        try:
            target_bytes = target_path.read_bytes()
            background_bytes = background_path.read_bytes()
            dimensions = self._image_dimensions(target_path, background_path)
            if dimensions is None:
                return None
            target_width, background_width = dimensions

            result = self._match(matcher, target_bytes, background_bytes)
            if not isinstance(result, dict):
                return None
            box = result.get("target")
            if not isinstance(box, (list, tuple)) or len(box) < 4:
                return None
            x1 = float(box[0])
            x2 = float(box[2])
            matched_width = max(1.0, x2 - x1, float(target_width))
            travel = max(1.0, float(background_width) - matched_width)
            fraction = max(0.0, min(1.0, x1 / travel))
            return {
                "found": True,
                "targetFraction": fraction,
                "confidence": 0.76,
                "source": "ddddocr-slide-match",
                "markId": "S3",
                "provider": "ddddocr",
                "matchBox": [float(value) for value in box[:4]],
            }
        except Exception:
            return None
        finally:
            self._clear_asset_marks()

    def status(self) -> Dict[str, Any]:
        return {
            "provider": "ddddocr",
            "optional": True,
            "enabledByDefault": True,
            "available": self.available(),
        }

    def _load_matcher(self) -> Any | None:
        if self._matcher is not None:
            return self._matcher
        if self._import_failed:
            return None
        try:
            import ddddocr  # type: ignore

            self._matcher = ddddocr.DdddOcr(det=False, ocr=False, show_ad=False)
            return self._matcher
        except Exception:
            self._import_failed = True
            return None

    def _discover_assets(self, state: Dict[str, Any]) -> Tuple[str, str] | None:
        track_selector = str(state.get("trackSelector") or "").strip()
        if not track_selector or str(state.get("scope") or "document") != "document":
            return None
        script = r"""
const trackSelector = arguments[0];
const track = document.querySelector(trackSelector);
if (!track) return null;
const visible = el => {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width >= 12 && r.height >= 12 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
};
const identity = el => `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute?.('aria-label') || ''}`.toLowerCase();
let container = track;
for (let i = 0; i < 5 && container?.parentElement; i++, container = container.parentElement) {
  const token = identity(container);
  if (/captcha|verify|slider|slide|puzzle|drag/.test(token)) break;
}
container = container || track.parentElement || document.body;
let nodes = [...container.querySelectorAll('img,canvas')].filter(visible);
if (nodes.length < 2) {
  const parent = track.parentElement?.parentElement || track.parentElement || document;
  nodes = [...parent.querySelectorAll('img,canvas')].filter(visible);
}
if (nodes.length < 2) return null;
const enriched = nodes.map((el, index) => {
  const r = el.getBoundingClientRect();
  const token = identity(el);
  const area = r.width * r.height;
  let bgScore = area;
  let pieceScore = 0;
  if (/background|\bbg\b|captcha|canvas|image/.test(token)) bgScore *= 1.35;
  if (/piece|puzzle|target|block|slider|slide/.test(token)) pieceScore += 1000000;
  pieceScore += 1 / Math.max(1, area) * 100000000;
  return {el,index,area,bgScore,pieceScore,width:r.width,height:r.height};
});
const background = [...enriched].sort((a,b) => b.bgScore-a.bgScore)[0];
if (!background) return null;
const pieces = enriched.filter(item => item.el !== background.el && item.area < background.area * 0.65 && item.width < background.width * 0.8);
const piece = pieces.sort((a,b) => b.pieceScore-a.pieceScore)[0];
if (!piece) return null;
background.el.setAttribute('data-ares-ddddocr-slider', 'background');
piece.el.setAttribute('data-ares-ddddocr-slider', 'target');
return {
  targetSelector: '[data-ares-ddddocr-slider="target"]',
  backgroundSelector: '[data-ares-ddddocr-slider="background"]'
};
"""
        try:
            result = self._sb.execute_script(script, track_selector)
        except Exception:
            return None
        if not isinstance(result, dict):
            return None
        target = str(result.get("targetSelector") or "").strip()
        background = str(result.get("backgroundSelector") or "").strip()
        return (target, background) if target and background else None

    def _capture(self, selector: str, filename: str) -> Path | None:
        root = self._profile_dir / ".ares-visual-cache" if self._profile_dir else Path(tempfile.gettempdir()) / "ares-visual-cache"
        try:
            root.mkdir(parents=True, exist_ok=True)
            path = root / filename
            self._sb.save_screenshot(filename, folder=str(root), selector=selector)
            return path if path.exists() and path.stat().st_size > 0 else None
        except Exception:
            return None

    @staticmethod
    def _image_dimensions(target_path: Path, background_path: Path) -> Tuple[int, int] | None:
        try:
            from PIL import Image

            with Image.open(target_path) as target, Image.open(background_path) as background:
                return int(target.width), int(background.width)
        except Exception:
            return None

    @staticmethod
    def _match(matcher: Any, target_bytes: bytes, background_bytes: bytes) -> Any:
        try:
            return matcher.slide_match(target_bytes, background_bytes)
        except Exception:
            return matcher.slide_match(target_bytes, background_bytes, simple_target=True)

    def _clear_asset_marks(self) -> None:
        script = """
for (const el of document.querySelectorAll('[data-ares-ddddocr-slider]')) {
  el.removeAttribute('data-ares-ddddocr-slider');
}
return true;
"""
        try:
            self._sb.execute_script(script)
        except Exception:
            pass
