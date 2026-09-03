import { path as ghostCursorPath } from "ghost-cursor";
import type { Page } from "patchright";
import type { InteractionPoint } from "./interaction-models";

export interface PointerClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface PointerDriver {
  moveTo(target: InteractionPoint): Promise<void>;
  click(target: InteractionPoint, options?: PointerClickOptions): Promise<void>;
}

/**
 * Normal browser pointer driver.
 *
 * `ghost-cursor`'s high-level cursor object is coupled to Puppeteer's private
 * CDP client. Patchright intentionally does not expose that private Puppeteer
 * API, so using createCursor(page) can compile while failing at runtime.
 *
 * We therefore use ghost-cursor's browser-independent path generator and let
 * Patchright execute those generated pointer coordinates through its public
 * mouse API. InteractionEngine still owns readiness, target selection,
 * retries and outcome verification.
 */
export class GhostCursorPointerDriver implements PointerDriver {
  private position: InteractionPoint = { x: 0, y: 0 };

  constructor(private readonly page: Page) {}

  async moveTo(target: InteractionPoint): Promise<void> {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      throw new TypeError("Pointer coordinates must be finite numbers.");
    }

    const route = ghostCursorPath(this.position, target);
    for (const point of route) {
      await this.page.mouse.move(point.x, point.y);
    }
    this.position = { ...target };
  }

  async click(target: InteractionPoint, options: PointerClickOptions = {}): Promise<void> {
    await this.moveTo(target);
    await this.page.mouse.click(target.x, target.y, {
      button: options.button ?? "left",
      clickCount: options.clickCount ?? 1
    });
  }
}
