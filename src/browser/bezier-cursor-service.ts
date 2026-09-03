import type { Locator, Page } from "patchright";
import { GhostCursorUiInteractionHelper, UiPoint } from "../browser-worker/ui-interaction-helper";

/** @deprecated Use GhostCursorUiInteractionHelper directly in new worker code. */
export class BezierCursorService {
  private readonly helpers = new WeakMap<Page, GhostCursorUiInteractionHelper>();

  async moveTo(page: Page, target: UiPoint): Promise<void> {
    await this.forPage(page).moveToPoint(target);
  }

  async clickLocator(page: Page, locator: Locator): Promise<void> {
    await this.forPage(page).click(locator);
  }

  private forPage(page: Page): GhostCursorUiInteractionHelper {
    const existing = this.helpers.get(page);
    if (existing) return existing;
    const helper = new GhostCursorUiInteractionHelper(page);
    this.helpers.set(page, helper);
    return helper;
  }
}
