import type { Locator, Page } from "../src/browser-worker/types";
import { InteractionEngine } from "../src/browser-worker/interaction-engine";
import type { InteractionTargetState } from "../src/browser-worker/interaction-models";
import type { InteractionStateObserver } from "../src/browser-worker/state-observer";

function readyState(): InteractionTargetState {
  return {
    visible: true,
    enabled: true,
    stable: true,
    box: { x: 100, y: 50, width: 200, height: 80 }
  };
}

function fakeLocator(): Locator {
  return {
    scrollIntoViewIfNeeded: jest.fn(async () => undefined)
  } as unknown as Locator;
}

function readyObserver(): InteractionStateObserver {
  return {
    waitUntilReady: jest.fn(async () => readyState())
  } as unknown as InteractionStateObserver;
}

function fakePage(): {
  page: Page;
  moves: Array<[number, number]>;
  clicks: Array<[number, number]>;
} {
  const moves: Array<[number, number]> = [];
  const clicks: Array<[number, number]> = [];
  const page = {
    mouse: {
      move: jest.fn(async (x: number, y: number) => { moves.push([x, y]); }),
      click: jest.fn(async (x: number, y: number) => { clicks.push([x, y]); })
    }
  } as unknown as Page;
  return { page, moves, clicks };
}

function signature(points: Array<[number, number]>): string {
  return points
    .map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`)
    .join("|");
}

describe("InteractionEngine bounded pointer variation", () => {
  const profiles = {
    pointer: {
      minSteps: 8,
      maxSteps: 18,
      minStepDelayMs: 0,
      maxStepDelayMs: 0,
      targetInsetRatio: 0.14,
      targetVariationRatio: 0.28
    }
  };

  it("produces diverse bounded paths across different seeds", async () => {
    const pathSignatures = new Set<string>();
    const clickSignatures = new Set<string>();
    const stepCounts = new Set<number>();

    for (let index = 0; index < 20; index++) {
      const run = fakePage();
      const engine = new InteractionEngine(run.page, profiles, readyObserver());
      const result = await engine.click(fakeLocator(), {
        attempts: 1,
        seed: `variation-${index}`
      });

      expect(result.success).toBe(true);
      expect(run.clicks).toHaveLength(1);
      expect(run.moves.length).toBeGreaterThanOrEqual(8);
      expect(run.moves.length).toBeLessThanOrEqual(18);

      const [clickX, clickY] = run.clicks[0]!;
      // 14% inset keeps all target points well inside the 200x80 target box.
      expect(clickX).toBeGreaterThanOrEqual(128);
      expect(clickX).toBeLessThanOrEqual(272);
      expect(clickY).toBeGreaterThanOrEqual(61.2);
      expect(clickY).toBeLessThanOrEqual(118.8);

      pathSignatures.add(signature(run.moves));
      clickSignatures.add(`${clickX.toFixed(3)},${clickY.toFixed(3)}`);
      stepCounts.add(run.moves.length);
    }

    // Variation is bounded but should not collapse to one repeated gesture.
    expect(pathSignatures.size).toBeGreaterThanOrEqual(18);
    expect(clickSignatures.size).toBeGreaterThanOrEqual(18);
    expect(stepCounts.size).toBeGreaterThanOrEqual(3);
  });

  it("replays the exact same path when the same seed is reused", async () => {
    const first = fakePage();
    const second = fakePage();
    const firstEngine = new InteractionEngine(first.page, profiles, readyObserver());
    const secondEngine = new InteractionEngine(second.page, profiles, readyObserver());

    await firstEngine.click(fakeLocator(), { attempts: 1, seed: "replayable-seed" });
    await secondEngine.click(fakeLocator(), { attempts: 1, seed: "replayable-seed" });

    expect(first.moves).toEqual(second.moves);
    expect(first.clicks).toEqual(second.clicks);
  });
});
