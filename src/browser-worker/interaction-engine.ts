import type { Locator, Page } from "patchright";
import {
  DEFAULT_INTERACTION_PROFILES,
  type ClickInteractionOptions,
  type FillInteractionOptions,
  type InteractionAttemptResult,
  type InteractionBox,
  type InteractionOutcomeVerifier,
  type InteractionPoint,
  type InteractionProfiles,
  type InteractionTargetState
} from "./interaction-models";
import { SeededRandom } from "./seeded-random";
import { InteractionStateObserver } from "./state-observer";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mergeProfiles(overrides?: Partial<InteractionProfiles>): InteractionProfiles {
  return {
    pointer: {
      ...DEFAULT_INTERACTION_PROFILES.pointer,
      ...(overrides?.pointer ?? {})
    },
    form: {
      ...DEFAULT_INTERACTION_PROFILES.form,
      ...(overrides?.form ?? {})
    }
  };
}

export class InteractionEngine {
  private readonly profiles: InteractionProfiles;
  private readonly observer: InteractionStateObserver;
  private pointer: InteractionPoint = { x: 0, y: 0 };

  constructor(
    private readonly page: Page,
    profiles?: Partial<InteractionProfiles>,
    observer?: InteractionStateObserver
  ) {
    this.profiles = mergeProfiles(profiles);
    this.observer = observer ?? new InteractionStateObserver();
  }

  async click(locator: Locator, options: ClickInteractionOptions = {}): Promise<InteractionAttemptResult> {
    const attempts = Math.max(1, Math.min(5, Math.floor(options.attempts ?? 2)));
    const readinessTimeoutMs = options.readinessTimeoutMs ?? this.profiles.form.readinessTimeoutMs;
    const verifyTimeoutMs = options.verifyTimeoutMs ?? this.profiles.form.verifyTimeoutMs;
    const baseSeed = options.seed ?? "ares-interaction";
    let lastState: InteractionTargetState = { visible: false, enabled: false, stable: false };

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      lastState = await this.observer.waitUntilReady(locator, readinessTimeoutMs);
      if (!lastState.visible || !lastState.enabled || !lastState.stable || !lastState.box) {
        if (attempt === attempts) break;
        continue;
      }

      const random = new SeededRandom(`${String(baseSeed)}:${attempt}`);
      const target = this.chooseTargetPoint(lastState.box, random);
      await this.movePointer(target, random);
      await this.page.mouse.click(target.x, target.y, {
        button: options.button ?? "left",
        clickCount: options.clickCount ?? 1
      });
      this.pointer = target;

      if (!options.expected || await this.waitForOutcome(options.expected, verifyTimeoutMs)) {
        return { success: true, attempts: attempt, targetState: lastState, targetPoint: target };
      }
    }

    return { success: false, attempts, targetState: lastState };
  }

  async fill(locator: Locator, value: string, options: FillInteractionOptions = {}): Promise<InteractionAttemptResult> {
    const attempts = Math.max(1, Math.min(5, Math.floor(options.attempts ?? 2)));
    const readinessTimeoutMs = options.readinessTimeoutMs ?? this.profiles.form.readinessTimeoutMs;
    const verifyTimeoutMs = options.verifyTimeoutMs ?? this.profiles.form.verifyTimeoutMs;
    let lastState: InteractionTargetState = { visible: false, enabled: false, stable: false };

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      lastState = await this.observer.waitUntilReady(locator, readinessTimeoutMs);
      if (!lastState.visible || !lastState.enabled || !lastState.stable) {
        if (attempt === attempts) break;
        continue;
      }

      await locator.fill(value);
      const expected = options.expected ?? (async () => {
        const current = await locator.inputValue().catch(() => "");
        return current === value;
      });

      if (await this.waitForOutcome(expected, verifyTimeoutMs)) {
        return { success: true, attempts: attempt, targetState: lastState };
      }
    }

    return { success: false, attempts, targetState: lastState };
  }

  private chooseTargetPoint(box: InteractionBox, random: SeededRandom): InteractionPoint {
    const insetRatio = clamp(this.profiles.pointer.targetInsetRatio, 0, 0.45);
    const variation = clamp(this.profiles.pointer.targetVariationRatio, 0, 0.5);
    const insetX = box.width * insetRatio;
    const insetY = box.height * insetRatio;
    const usableWidth = Math.max(1, box.width - insetX * 2);
    const usableHeight = Math.max(1, box.height - insetY * 2);
    const centerX = box.x + insetX + usableWidth / 2;
    const centerY = box.y + insetY + usableHeight / 2;
    const maxOffsetX = usableWidth * variation;
    const maxOffsetY = usableHeight * variation;

    return {
      x: clamp(centerX + random.between(-maxOffsetX, maxOffsetX), box.x + insetX, box.x + box.width - insetX),
      y: clamp(centerY + random.between(-maxOffsetY, maxOffsetY), box.y + insetY, box.y + box.height - insetY)
    };
  }

  private async movePointer(target: InteractionPoint, random: SeededRandom): Promise<void> {
    const profile = this.profiles.pointer;
    const steps = random.integer(profile.minSteps, profile.maxSteps);
    const start = { ...this.pointer };
    const distanceX = target.x - start.x;
    const distanceY = target.y - start.y;
    const bend = Math.max(8, Math.min(60, Math.hypot(distanceX, distanceY) * 0.12));
    const direction = random.next() < 0.5 ? -1 : 1;
    const control1 = {
      x: start.x + distanceX * random.between(0.22, 0.38) - direction * bend * (distanceY === 0 ? 0.2 : Math.sign(distanceY)),
      y: start.y + distanceY * random.between(0.22, 0.38) + direction * bend * (distanceX === 0 ? 0.2 : Math.sign(distanceX))
    };
    const control2 = {
      x: start.x + distanceX * random.between(0.62, 0.82) + direction * bend * (distanceY === 0 ? 0.15 : Math.sign(distanceY)),
      y: start.y + distanceY * random.between(0.62, 0.82) - direction * bend * (distanceX === 0 ? 0.15 : Math.sign(distanceX))
    };

    for (let index = 1; index <= steps; index++) {
      const t = index / steps;
      const inverse = 1 - t;
      const x = inverse ** 3 * start.x
        + 3 * inverse ** 2 * t * control1.x
        + 3 * inverse * t ** 2 * control2.x
        + t ** 3 * target.x;
      const y = inverse ** 3 * start.y
        + 3 * inverse ** 2 * t * control1.y
        + 3 * inverse * t ** 2 * control2.y
        + t ** 3 * target.y;
      await this.page.mouse.move(x, y);
      const delay = random.integer(profile.minStepDelayMs, profile.maxStepDelayMs);
      if (delay > 0) await sleep(delay);
    }
  }

  private async waitForOutcome(verifier: InteractionOutcomeVerifier, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      try {
        if (await verifier()) return true;
      } catch {
        // The UI may be re-rendering between action and verification.
      }
      if (Date.now() >= deadline) break;
      await sleep(50);
    } while (true);
    return false;
  }
}
