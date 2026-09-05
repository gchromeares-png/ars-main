from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List


class AuthorizedGridActionExecutor:
    """Click externally selected indexes on the current authorized test grid."""

    def __init__(self, seleniumbase_cdp: Any, grid_adapter: Any) -> None:
        self._sb = seleniumbase_cdp
        self._grid_adapter = grid_adapter

    def apply(
        self,
        indexes: Iterable[int],
        *,
        expected_signature: str = "",
        submit: bool = True,
    ) -> Dict[str, Any]:
        before = self._grid_adapter.poll()
        selected = sorted({int(index) for index in indexes if int(index) >= 0})
        if before.get("kind") != "image-grid":
            return {"status": "no-grid", "clickedIndexes": []}
        if expected_signature and before.get("signature") != expected_signature:
            return {"status": "stale-grid", "clickedIndexes": []}
        if any(index >= int(before.get("tileCount") or 0) for index in selected):
            return {"status": "invalid-index", "clickedIndexes": []}

        result = self._click_dom(selected, submit)
        if result.get("status") == "not-found" and str(before.get("scope") or "").startswith("iframe:"):
            result = self._click_frame(before, selected, submit)

        after = self._grid_adapter.poll()
        return {
            **result,
            "generationChanged": before.get("signature") != after.get("signature"),
            "state": after,
        }

    def _click_dom(self, indexes: List[int], submit: bool) -> Dict[str, Any]:
        overrides = json.dumps(getattr(self._grid_adapter, "_overrides", {}) or {})
        script = f"""
        (() => {{
          const o={overrides}, wanted={json.dumps(indexes)}, doSubmit={str(submit).lower()};
          const visible=e=>{{if(!e?.getBoundingClientRect)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>=24&&r.height>=24&&s.display!=='none'&&s.visibility!=='hidden'}};
          const roots=[],seen=new Set(),walk=r=>{{if(!r||seen.has(r))return;seen.add(r);roots.push(r);for(const e of r.querySelectorAll?.('*')||[])if(e.shadowRoot)walk(e.shadowRoot);for(const f of r.querySelectorAll?.('iframe')||[])try{{if(f.contentDocument)walk(f.contentDocument)}}catch{{}}}};
          walk(document);
          const tiles=r=>{{
            if(o.tiles){{const x=[...(r.querySelectorAll?.(o.tiles)||[])].filter(visible);if([9,16].includes(x.length))return x}}
            for(const p of [...new Set([...(r.querySelectorAll?.('img')||[])].filter(visible).flatMap(img=>{{const a=[];for(let n=img,d=0;n&&d<5;d++,n=n.parentElement)if(n.parentElement)a.push(n.parentElement);return a}}))]){{
              const imgs=[...p.querySelectorAll('img')].filter(visible);if([9,16].includes(imgs.length))return imgs.map(i=>i.closest('button,[role="button"],[tabindex],label,li,div')||i)
            }}
            return [];
          }};
          for(const r of roots){{
            const t=tiles(r);if(![9,16].includes(t.length))continue;
            for(const i of wanted){{const e=t[i];if(!visible(e))return {{status:'stale-grid',clickedIndexes:[]}};e.scrollIntoView({{block:'center',inline:'center'}});e.click()}}
            let submitted=false;
            if(doSubmit){{const s=(o.submit&&r.querySelector?.(o.submit))||[...(t[0]?.parentElement?.parentElement?.querySelectorAll?.('button,input[type="submit"],[role="button"]')||[])].find(e=>visible(e)&&!t.includes(e));if(s){{s.click();submitted=true}}}}
            return {{status:'clicked',clickedIndexes:wanted,submitted,strategy:'dom'}};
          }}
          return {{status:'not-found',clickedIndexes:[],submitted:false,strategy:'dom'}};
        }})()
        """
        value = self._evaluate(script)
        return value if isinstance(value, dict) else {"status": "not-found", "clickedIndexes": []}

    def _click_frame(self, snapshot: Dict[str, Any], indexes: List[int], submit: bool) -> Dict[str, Any]:
        frame = list(self._sb.find_elements("iframe") or [])[int(str(snapshot["scope"]).split(":", 1)[1])]
        images = list(frame.query_selector_all("img") or [])
        for index in indexes:
            (getattr(images[index], "click", None) or getattr(images[index], "mouse_click"))()
        submitted = False
        if submit:
            for button in frame.query_selector_all('button,input[type="submit"],[role="button"]') or []:
                click = getattr(button, "click", None) or getattr(button, "mouse_click", None)
                if callable(click):
                    click(); submitted = True; break
        return {"status": "clicked", "clickedIndexes": indexes, "submitted": submitted, "strategy": "frame"}

    def _evaluate(self, script: str) -> Any:
        evaluate = getattr(self._sb, "evaluate", None)
        return evaluate(script) if callable(evaluate) else self._sb.execute_script(f"return {script};")
