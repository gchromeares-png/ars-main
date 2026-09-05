from __future__ import annotations

import json
from typing import Any, Dict


class VisionGridRunner:
    def __init__(self, adapter: Any, classifier: Any, *, aliases: Dict[str, str] | None = None, threshold: float = 0.72) -> None:
        self.adapter = adapter
        self.classifier = classifier
        self.aliases = aliases or {}
        self.threshold = float(threshold)
        self._last_signature = ""

    def tick(self) -> Dict[str, Any]:
        state = self.adapter.site_grid_state()
        signature = str(state.get("signature") or "")
        if state.get("kind") != "image-grid" or not signature or signature == self._last_signature:
            return {"status": "idle", "state": state}

        target = self.classifier.target_from_instruction(str(state.get("instruction") or ""), self.aliases)
        if not target:
            self._last_signature = signature
            return {"status": "target-unresolved", "state": state}

        sources = self._browser_resolve_sources(state.get("sources") or [])
        predictions = self.classifier.predict_sources(sources)
        indexes = self.classifier.selected_indexes(predictions, target, self.threshold)
        if not indexes:
            self._last_signature = signature
            return {"status": "no-selection", "target": target, "predictions": [p.__dict__ for p in predictions], "state": state}

        result = self.adapter.apply_grid_selection(indexes, submit=True)
        after = result.get("state") or self.adapter.site_grid_state()
        self._last_signature = "" if after.get("signature") != signature else signature
        return {"status": "clicked", "target": target, "indexes": indexes, "predictions": [p.__dict__ for p in predictions], "action": result}

    def _browser_resolve_sources(self, sources: list[str]) -> list[str]:
        script = f"""
        (async()=>{{
          const sources={json.dumps([str(value) for value in sources])}, out=[];
          const clean=s=>s.startsWith('url(')?s.slice(4,-1).trim().replace(/^['\"]|['\"]$/g,''):s;
          for(const raw of sources){{
            const source=clean(raw);
            if(source.startsWith('data:image/')){{out.push(source);continue}}
            try{{
              const response=await fetch(source,{{credentials:'include'}}), blob=await response.blob();
              const data=await new Promise((resolve,reject)=>{{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob)}});
              out.push(data);
            }}catch{{out.push(source)}}
          }}
          return out;
        }})()
        """
        try:
            resolved = self.adapter.execute_async_script(script)
            return [str(value) for value in resolved] if isinstance(resolved, list) and len(resolved) == len(sources) else [str(value) for value in sources]
        except Exception:
            return [str(value) for value in sources]
