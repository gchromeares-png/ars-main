from __future__ import annotations

import json
from typing import Any, Dict, Iterable


_DIALOG_SELECTORS = (
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[class*="cookie" i]',
    '[id*="cookie" i]',
    '[class*="consent" i]',
    '[id*="consent" i]',
    '[class*="modal" i]',
)
_BUTTON_SELECTORS = (
    'button',
    'input[type="submit"]',
    'input[type="button"]',
    '[role="button"]',
    'a[href]',
)
_ACCEPT_TEXT = (
    'alles akzeptieren',
    'alle akzeptieren',
    'accept all',
    'allow all',
    'akzeptieren',
    'accept',
    'zustimmen',
    'i agree',
    'ok',
    'weiter',
    'continue',
)
_PROGRESS_TEXT = (
    'bestätigen und weiter',
    'weiter',
    'fortfahren',
    'continue',
    'ok',
    'weiter zur kasse',
    'zur kasse',
    'checkout',
    'go to checkout',
    'continue to checkout',
    'proceed to checkout',
    'weiter zum checkout',
    'zum checkout',
    'weiter zur lieferung',
    'continue to shipping',
    'weiter zur zahlung',
    'continue to payment',
)
_CHECKOUT_TEXT = (
    'weiter zur kasse',
    'zur kasse',
    'checkout',
    'go to checkout',
    'continue to checkout',
    'proceed to checkout',
    'weiter zum checkout',
    'zum checkout',
    'weiter zur lieferung',
    'weiter zur zahlung',
    'continue to shipping',
    'continue to payment',
)


class ConsentPopupHandler:
    """Dismiss explicit popups and advance only reversible controls with CDP mouse clicks."""

    def __init__(self, seleniumbase_cdp: Any) -> None:
        self._sb = seleniumbase_cdp

    def dismiss_once(self) -> Dict[str, Any]:
        cdp = getattr(self._sb, 'cdp', self._sb)
        if cdp is None:
            return {'dismissed': False, 'reason': 'cdp-unavailable'}
        if not self._candidate_exists(_ACCEPT_TEXT):
            return {'dismissed': False, 'reason': 'no-explicit-consent-control'}

        for dialog_selector in _DIALOG_SELECTORS:
            try:
                dialogs = list(cdp.find_elements(dialog_selector) or [])
            except Exception:
                dialogs = []
            for dialog in dialogs:
                result = self._click_in_root(dialog)
                if result.get('dismissed'):
                    return result

        result = self._click_in_root(cdp, fallback=True)
        if result.get('dismissed'):
            return result

        try:
            frames = list(cdp.find_elements('iframe') or [])
        except Exception:
            frames = []
        for frame in frames:
            result = self._click_in_root(frame, fallback=True)
            if result.get('dismissed'):
                return {**result, 'scope': 'iframe'}

        return {'dismissed': False, 'reason': 'no-explicit-consent-control'}

    def advance_progress_once(self) -> Dict[str, Any]:
        """Advance only conservative confirm/continue/pre-payment checkout controls."""
        return self._advance_once(_PROGRESS_TEXT, empty_reason='no-progress-control')

    def advance_checkout_once(self) -> Dict[str, Any]:
        """Advance only reversible checkout-navigation controls; never final purchase."""
        return self._advance_once(_CHECKOUT_TEXT, empty_reason='no-checkout-control')

    def _advance_once(self, values: Iterable[str], *, empty_reason: str) -> Dict[str, Any]:
        cdp = getattr(self._sb, 'cdp', self._sb)
        if cdp is None:
            return {'advanced': False, 'reason': 'cdp-unavailable'}
        candidates = tuple(str(value) for value in values)
        if not self._candidate_exists(candidates):
            return {'advanced': False, 'reason': empty_reason}

        for root, scope in self._roots(cdp):
            for selector in _BUTTON_SELECTORS:
                for element in self._elements(root, selector):
                    text = self._element_text(element)
                    if not text or not self._matches(text, candidates):
                        continue
                    click = getattr(element, 'mouse_click', None)
                    if not callable(click):
                        continue
                    try:
                        click()
                        return {
                            'advanced': True,
                            'text': text,
                            'selector': selector,
                            'scope': scope,
                            'mode': 'cdp-mouse-click',
                        }
                    except Exception:
                        continue
        return {'advanced': False, 'reason': empty_reason}

    def _candidate_exists(self, values: Iterable[str]) -> bool:
        """Cheap read-only gate before SeleniumBase element queries with implicit waits.

        Runtime polling must stay cheap when no popup/progress control exists. The
        preflight recursively inspects only script-accessible documents; any real
        candidate still uses the existing trusted CDP mouse-click path below.
        """
        candidates = [str(value).strip().lower() for value in values if str(value).strip()]
        if not candidates:
            return False
        script = f"""
        (() => {{
          const candidates = {json.dumps(candidates)};
          const selectors = {json.dumps(list(_BUTTON_SELECTORS))};
          const normalize = value => String(value || '').trim().toLowerCase().replace(/\\s+/g, ' ');
          const matches = raw => {{
            const text = normalize(raw);
            if (!text) return false;
            return candidates.some(rawCandidate => {{
              const candidate = normalize(rawCandidate);
              if (!candidate) return false;
              if (text === candidate) return true;
              return candidate.includes(' ') && candidate.length > 8 && text.includes(candidate);
            }});
          }};
          const elementText = element =>
            element?.innerText || element?.textContent || element?.getAttribute?.('value') ||
            element?.getAttribute?.('aria-label') || element?.getAttribute?.('title') || '';
          const seen = new Set();
          const scan = doc => {{
            if (!doc || seen.has(doc)) return false;
            seen.add(doc);
            for (const selector of selectors) {{
              let elements = [];
              try {{ elements = Array.from(doc.querySelectorAll(selector)); }} catch (_) {{}}
              if (elements.some(element => matches(elementText(element)))) return true;
            }}
            let frames = [];
            try {{ frames = Array.from(doc.querySelectorAll('iframe,frame')); }} catch (_) {{}}
            for (const frame of frames) {{
              try {{ if (frame.contentDocument && scan(frame.contentDocument)) return true; }} catch (_) {{}}
            }}
            return false;
          }};
          return scan(document);
        }})()
        """
        try:
            evaluator = getattr(self._sb, 'evaluate', None)
            if callable(evaluator):
                return bool(evaluator(script))
            executor = getattr(self._sb, 'execute_script', None)
            if callable(executor):
                return bool(executor(f"return {script};"))
        except Exception:
            # Fail open to the established CDP query path when cheap observation
            # itself is unavailable; behavior is preserved rather than skipped.
            return True
        return True

    def _click_in_root(self, root: Any, *, fallback: bool = False) -> Dict[str, Any]:
        accepted = set(_ACCEPT_TEXT)
        strong = {'alles akzeptieren', 'alle akzeptieren', 'accept all', 'allow all', 'zustimmen', 'i agree'}
        for selector in _BUTTON_SELECTORS:
            elements = self._elements(root, selector)
            for element in elements:
                text = self._element_text(element)
                if text not in accepted:
                    continue
                if fallback and text not in strong:
                    continue
                click = getattr(element, 'mouse_click', None)
                if not callable(click):
                    continue
                try:
                    click()
                    return {
                        'dismissed': True,
                        'text': text,
                        'selector': selector,
                        'mode': 'cdp-mouse-click',
                    }
                except Exception:
                    continue
        return {'dismissed': False}

    @classmethod
    def _roots(cls, cdp: Any):
        yield cdp, 'document'
        try:
            frames = list(cdp.find_elements('iframe') or [])
        except Exception:
            frames = []
        for frame in frames:
            yield frame, 'iframe'

    @staticmethod
    def _matches(text: str, values: Iterable[str]) -> bool:
        normalized = ' '.join(str(text or '').strip().lower().split())
        for value in values:
            candidate = ' '.join(str(value or '').strip().lower().split())
            if not candidate:
                continue
            if normalized == candidate:
                return True
            # Single-word controls are intentionally exact-only. This prevents
            # generic "continue"/"weiter" text from matching an irreversible
            # order control that merely contains the same word.
            if ' ' in candidate and len(candidate) > 8 and candidate in normalized:
                return True
        return False

    @staticmethod
    def _elements(root: Any, selector: str) -> Iterable[Any]:
        for name in ('find_elements', 'query_selector_all'):
            method = getattr(root, name, None)
            if not callable(method):
                continue
            try:
                return list(method(selector) or [])
            except Exception:
                continue
        return []

    @staticmethod
    def _element_text(element: Any) -> str:
        for name in ('text', 'text_content'):
            try:
                value = getattr(element, name, '')
                if callable(value):
                    value = value()
                text = ' '.join(str(value or '').strip().lower().split())
                if text:
                    return text
            except Exception:
                pass
        getter = getattr(element, 'get_attribute', None)
        if callable(getter):
            for attr in ('value', 'aria-label', 'title'):
                try:
                    text = ' '.join(str(getter(attr) or '').strip().lower().split())
                except Exception:
                    text = ''
                if text:
                    return text
        return ''
