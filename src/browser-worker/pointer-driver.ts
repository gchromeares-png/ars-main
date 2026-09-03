import { createCursor } from "ghost-cursor";
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
 * Normal browser pointer driver. InteractionEngine still decides readiness,
 * target, retries and outcome; ghost-cursor only executes pointer movement.
 */
export class GhostCursorPointerDriver implements PointerDriver {
  private readonly cursor: ReturnType<typeof createCursor>;

  constructor(page: Page) {
    this.cursor = createCursor(page);
  }

  async moveTo(target: InteractionPoint): Promise<void> {
    await this.cursor.moveTo(target, {
      moveDelay: 0,
      randomizeMoveDelay: false
    });
  }

  async click(target: InteractionPoint, options: PointerClickOptions = {}): Promise<void> {
    await this.moveTo(target);
    await this.cursor.click(undefined, {
      button: options.button ?? "left",
      clickCount: options.clickCount ?? 1,
      moveDelay: 0,
      randomizeMoveDelay: false
    });
  }
}
