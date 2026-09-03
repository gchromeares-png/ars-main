import { path as ghostPath } from "ghost-cursor";
import type { Locator, Page } from "patchright";

export interface UiPoint {
  x: number;
  y: number;
}

export interface UiMoveOptions {
  stepDelayMs?: number;
}

export interface UiClickOptions extends UiMoveOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface UiInteractionHelper {
  moveTo(target: Locator, options?: UiMoveOptions): Promise<void>;
  moveToPoint(point: UiPoint, options?: UiMoveOptions): Promise<void>;
  click(target: Locator, options?: UiClickOptions): Promise<void>;
}

/**
 * Standard UI-test helper. ghost-cursor is used only as a 2D Bézier path
 * generator; Patchright dispatches the actual mouse events.
 */
export class GhostCursorUiInteractionHelper implements UiInteractionHelper {
  private position: UiPoint = { x: 0, y: 0 };

  constructor(private readonly page: Page) {}

  async moveTo(target: Locator, options: UiMoveOptions = {}): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    await target.waitFor({ state: "visible" });
    const box = await target.boundingBox();
    if (!box) throw new Error("UI target has no visible bounding box.");

    await this.moveToPoint({
      x: box.x + box.width / 2,
      y: box.y + box.height / 2
    }, options);
  }

  async moveToPoint(target: UiPoint, options: UiMoveOptions = {}): Promise<void> {
    this.assertPoint(target);
    const route = ghostPath(this.position, target) as UiPoint[];
    for (const point of route) {
      await this.page.mouse.move(point.x, point.y);
      if (options.stepDelayMs && options.stepDelayMs > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, options.stepDelayMs));
      }
    }
    this.position = { ...target };
  }

  async click(target: Locator, options: UiClickOptions = {}): Promise<void> {
    await this.moveTo(target, options);
    await this.page.mouse.click(this.position.x, this.position.y, {
      button: options.button ?? "left",
      clickCount: options.clickCount ?? 1
    });
  }

  private assertPoint(point: UiPoint): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new TypeError("Cursor coordinates must be finite numbers.");
    }
  }
}
