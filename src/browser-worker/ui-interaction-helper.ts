import type { Locator, Page } from "patchright";
import { InteractionEngine } from "./interaction-engine";
import type { InteractionOutcomeExpectation } from "./interaction-policies";

export interface UiPoint {
  x: number;
  y: number;
}

export interface UiMoveOptions {
  stepDelayMs?: number;
  seed?: number | string;
}

export interface UiClickOptions extends UiMoveOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  attempts?: number;
  expected?: InteractionOutcomeExpectation;
}

export interface UiFillOptions {
  attempts?: number;
  seed?: number | string;
  expected?: InteractionOutcomeExpectation;
}

export interface UiSelectOptions extends UiFillOptions {}
export interface UiFocusOptions extends UiFillOptions {}

export interface UiInteractionHelper {
  moveTo(target: Locator, options?: UiMoveOptions): Promise<void>;
  moveToPoint(point: UiPoint, options?: UiMoveOptions): Promise<void>;
  click(target: Locator, options?: UiClickOptions): Promise<void>;
  fill(target: Locator, value: string, options?: UiFillOptions): Promise<void>;
  select(target: Locator, value: string, options?: UiSelectOptions): Promise<void>;
  focus(target: Locator, options?: UiFocusOptions): Promise<void>;
}

/**
 * Backwards-compatible facade for normal UI automation.
 * Stateful actions delegate to InteractionEngine; challenge handling stays separate.
 */
export class GhostCursorUiInteractionHelper implements UiInteractionHelper {
  private readonly engine: InteractionEngine;
  private position: UiPoint = { x: 0, y: 0 };

  constructor(private readonly page: Page) {
    this.engine = new InteractionEngine(page);
  }

  async moveTo(target: Locator, options: UiMoveOptions = {}): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    await target.waitFor({ state: "visible" });
    const box = await target.boundingBox();
    if (!box) throw new Error("UI target has no visible bounding box.");
    await this.moveToPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, options);
  }

  async moveToPoint(target: UiPoint, options: UiMoveOptions = {}): Promise<void> {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      throw new TypeError("Cursor coordinates must be finite numbers.");
    }
    const steps = 10;
    const delay = Math.max(0, Math.floor(options.stepDelayMs ?? 0));
    const start = { ...this.position };
    for (let index = 1; index <= steps; index++) {
      const t = index / steps;
      await this.page.mouse.move(
        start.x + (target.x - start.x) * t,
        start.y + (target.y - start.y) * t
      );
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
    this.position = { ...target };
  }

  async click(target: Locator, options: UiClickOptions = {}): Promise<void> {
    const result = await this.engine.click(target, {
      seed: options.seed,
      attempts: options.attempts,
      expected: options.expected,
      button: options.button,
      clickCount: options.clickCount
    });
    this.assertSuccess("click", result.success, result.failureReason);
  }

  async fill(target: Locator, value: string, options: UiFillOptions = {}): Promise<void> {
    const result = await this.engine.fill(target, value, {
      attempts: options.attempts,
      seed: options.seed,
      expected: options.expected
    });
    this.assertSuccess("fill", result.success, result.failureReason);
  }

  async select(target: Locator, value: string, options: UiSelectOptions = {}): Promise<void> {
    const result = await this.engine.select(target, value, {
      attempts: options.attempts,
      seed: options.seed,
      expected: options.expected
    });
    this.assertSuccess("select", result.success, result.failureReason);
  }

  async focus(target: Locator, options: UiFocusOptions = {}): Promise<void> {
    const result = await this.engine.focus(target, {
      attempts: options.attempts,
      seed: options.seed,
      expected: options.expected
    });
    this.assertSuccess("focus", result.success, result.failureReason);
  }

  private assertSuccess(action: string, success: boolean, failureReason?: string): void {
    if (!success) throw new Error(`Interaction ${action} failed: ${failureReason ?? "unknown"}`);
  }
}
