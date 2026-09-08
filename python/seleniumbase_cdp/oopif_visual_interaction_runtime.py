from __future__ import annotations

from typing import Any, Dict
from pathlib import Path

from auto_interaction_controller import AutoInteractionController
from proximity_grid_action_executor import ProximityGridActionExecutor
from runtime_oopif_grid_site_adapter import ScopeLockedGridSiteAdapter
from visual_interaction_runtime import VisualInteractionRuntime


class OopifVisualInteractionRuntime(VisualInteractionRuntime):
    """Production visual runtime with OOPIF-only direct-children grid discovery."""

    def __init__(
        self,
        seleniumbase_cdp: Any,
        *,
        profile_dir: str | Path,
        overrides: Dict[str, str] | None = None,
        capture: Any = None,
    ) -> None:
        super().__init__(
            seleniumbase_cdp,
            profile_dir=profile_dir,
            overrides=overrides,
            capture=capture,
        )
        self._grid = ScopeLockedGridSiteAdapter(self._sb, overrides=overrides or {})
        self._grid_actions = ProximityGridActionExecutor(
            self._sb,
            self._grid,
            self._policy,
            self._paths,
        )
        self._controller = AutoInteractionController(
            self._grid,
            self._slider,
            self._grid_actions,
            self._slider_actions,
            self._vision,
            self._slider_grounder,
            self._trace,
        )
