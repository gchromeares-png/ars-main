import type { Locator, Page } from "patchright";
import { InteractionEngine } from "../src/browser-worker/interaction-engine";
import { SeededRandom } from "../src/browser-worker/seeded-random";
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

function fakeLocator(overrides: Partial<Record<string, jest.Mock>> = {}): Locator {
  return {
    scrollIntoViewIfNeeded: overrides["scrollIntoViewIfNeeded"] ?? jest.fn(async () => undefined),
    fill: overrides["fill"] ?? jest.fn(async () => undefined),
    inputValue: overrides["inputValue"] ?? jest.fn(async () => "")
  } as unknown as Locator;
}

function fakePage(): { page: Page; moves: Array<[number, number]>; clicks: Array<[number, number]> } {
  const moves: Array<[number, number]> = [];
  const clicks: Array<[number, number]> = [];
  const page = {
    mouse: {
      move: jest.fn(async (x: number, y: number) => { moves.push([x, y]); }),
      click: jest.fn(async (x: number, y: number) => { clicks.push([x, y]); })
    },
    url: jest.fn(() => "https://example.test/")
  } as unknown as Page;
  return { page, moves, clicks };
}

function observer(states: InteractionTargetState[]): InteractionStateObserver {
  let index = 0;
  return {
    waitUntilReady: jest.fn(async () => states[Math.min(index++, states.length - 1)] ?? readyState())
  } as unknown as InteractionStateObserver;
}

describe("InteractionEngine", () => {
  it("keeps seeded planning reproducible", () => {
    const first = new SeededRandom("task-42:1");
    const second = new SeededRandom("task-42:1");
    expect(Array.from({ length: 8 }, () => first.next()))
      .toEqual(Array.from({ length: 8 }, () => second.next()));
  });

  it("does not perform an action when readiness rejects the target", async () => {
    const { page, clicks } = fakePage();
    const locator = fakeLocator();
    const engine = new InteractionEngine(page, undefined, observer([{
      visible: true,
      enabled: false,
      stable: true,
      box: { x: 10, y: 10, width: 80, height: 30 }
    }]));

    const result = await engine.click(locator, { attempts: 1, seed: "blocked" });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("not-ready");
    expect(clicks).toHaveLength(0);
    expect(result.trace[0]).toEqual(expect.objectContaining({
      readinessPolicy: "visible-enabled-stable",
      failureReason: "not-ready",
      seed: "blocked:1"
    }));
  });

  it("re-observes state and retries with a deterministic attempt seed after an outcome timeout", async () => {
    const { page, clicks } = fakePage();
    const locator = fakeLocator();
    let checks = 0;
    const engine = new InteractionEngine(page, {
      pointer: {
        minSteps: 2,
        maxSteps: 2,
        minStepDelayMs: 0,
        maxStepDelayMs: 0,
        targetInsetRatio: 0.1,
        targetVariationRatio: 0.2
      }
    }, observer([readyState(), readyState()]));

    const result = await engine.click(locator, {
      attempts: 2,
      seed: "retry-case",
      verifyTimeoutMs: 0,
      expected: {
        name: "state-changed",
        verify: async () => ++checks >= 2
      }
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(clicks).toHaveLength(2);
    expect(result.trace[0]).toEqual(expect.objectContaining({
      seed: "retry-case:1",
      failureReason: "outcome-timeout",
      outcomeExpectation: "state-changed"
    }));
    expect(result.trace[1]).toEqual(expect.objectContaining({
      seed: "retry-case:2",
      outcomeExpectation: "state-changed"
    }));
  });

  it("verifies form fill outcome instead of trusting fill() completion", async () => {
    let current = "";
    const fill = jest.fn(async (value: string) => { current = value; });
    const inputValue = jest.fn(async () => current);
    const locator = fakeLocator({ fill, inputValue });
    const { page } = fakePage();
    const engine = new InteractionEngine(page, undefined, observer([readyState()]));

    const result = await engine.fill(locator, "Max Mustermann", {
      attempts: 1,
      seed: "form-name",
      verifyTimeoutMs: 0
    });

    expect(result.success).toBe(true);
    expect(fill).toHaveBeenCalledWith("Max Mustermann");
    expect(inputValue).toHaveBeenCalled();
    expect(result.trace[0]).toEqual(expect.objectContaining({
      seed: "form-name:1",
      outcomeExpectation: "locator-value-equals"
    }));
  });

  it("produces the same click point for the same initial state and seed", async () => {
    const locatorA = fakeLocator();
    const locatorB = fakeLocator();
    const first = fakePage();
    const second = fakePage();
    const profiles = {
      pointer: {
        minSteps: 3,
        maxSteps: 3,
        minStepDelayMs: 0,
        maxStepDelayMs: 0,
        targetInsetRatio: 0.15,
        targetVariationRatio: 0.3
      }
    };

    const engineA = new InteractionEngine(first.page, profiles, observer([readyState()]));
    const engineB = new InteractionEngine(second.page, profiles, observer([readyState()]));
    const options = { attempts: 1, seed: "same-seed" };

    const a = await engineA.click(locatorA, options);
    const b = await engineB.click(locatorB, options);

    expect(a.targetPoint).toEqual(b.targetPoint);
    expect(first.clicks[0]).toEqual(second.clicks[0]);
  });
});
