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

export interface UiInteractionHelper {
  moveTo(target: Locator, options?: UiMoveOptions): Promise<void>;
  moveToPoint(point: UiPoint, options?: UiMoveOptions): Promise<void>;
  click(target: Locator, options?: UiClickOptions): Promise<void>;
  fill(target: Locator, value: string, options?: UiFillOptions): Promise<void>;
  select(target: Locator, value: string, options?: UiSelectOptions): Promise<void>;
  focus(target: Locator): Promise<void>;
}

/**
 * Backwards-compatible facade for normal UI automation.
 * All stateful click/form work is delegated to InteractionEngine.
 * CAPTCHA/challenge handling is intentionally separate.
 */
export class GhostCursorUiInteractionHelper implements UiInteractionHelper {
  private readonly engine: InteractionEngine;

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
    const start = { x: 0, y: 0 };
    for (let index = 1; index <= steps; index++) {
      const t = index / steps;
      await this.page.mouse.move(
        start.x + (target.x - start.x) * t,
        start.y + (target.y - start.y) * t
      );
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
  }

  async click(target: Locator, options: UiClickOptions = {}): Promise<void> {
    const result = await this.engine.click(target, {
      seed: options.seed,
      attempts: options.attempts,
      expected: options.expected,
      button: options.button,
      clickCount: options.clickCount
    });
    if (!result.success) {
      throw new Error(`Interaction click failed: ${result.failureReason ?? "unknown"}`);
    }
  }

  async fill(target: Locator, value: string, options: UiFillOptions = {}): Promise<void> {
    const result = await this.engine.fill(target, value, {
      attempts: options.attempts,
      seed: options.seed,
      expected: options.expected
    });
    if (!result.success) {
      throw new Error(`Interaction fill failed: ${result.failureReason ?? "unknown"}`);
    }
  }

  async select(target: Locator, value: string, options: UiSelectOptions = {}): Promise<void> {
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.waitFor({ state: "visible" });
    if (!await target.isEnabled()) throw new Error("Interaction select failed: target disabled");

    const attempts = Math.max(1, Math.min(5, Math.floor(options.attempts ?? 2)));
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await target.selectOption(value);
        const selected = await target.inputValue().catch(() => "");
        const verified = options.expected
          ? await options.expected.verify(this.page)
          : selected === value;
        if (verified) return;
      } catch {
        // Re-evaluate the live element on the next bounded attempt.
      }
    }
    throw new Error("Interaction select failed: outcome-timeout");
  }

  async focus(target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.waitFor({ state: "visible" });
    if (!await target.isEnabled()) throw new Error("Interaction focus failed: target disabled");
    await target.focus();
  }
}
