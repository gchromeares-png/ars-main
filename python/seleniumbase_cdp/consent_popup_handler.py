from __future__ import annotations

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


class ConsentPopupHandler:
    """Dismiss explicit consent/continue controls with CDP element mouse clicks."""

    def __init__(self, seleniumbase_cdp: Any) -> None:
        self._sb = seleniumbase_cdp

    def dismiss_once(self) -> Dict[str, Any]:
        cdp = getattr(self._sb, 'cdp', None)
        if cdp is None:
            return {'dismissed': False, 'reason': 'cdp-unavailable'}

        for dialog_selector in _DIALOG_SELECTORS:
            try:
                dialogs = list(cdp.find_elements(dialog_selector) or [])
            except Exception:
                dialogs = []
            for dialog in dialogs:
                result = self._click_in_root(dialog)
                if result.get('dismissed'):
                    return result

        # Some consent banners are not marked as dialogs. Restrict the fallback
        # to strong consent wording so ordinary page buttons are not clicked.
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
