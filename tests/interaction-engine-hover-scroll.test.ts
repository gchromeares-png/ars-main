import type { Locator, Page } from "../src/browser-worker/types";
import { InteractionEngine } from "../src/browser-worker/interaction-engine";
import type { InteractionTargetState } from "../src/browser-worker/interaction-models";
import type { PointerDriver } from "../src/browser-worker/pointer-driver";
import type { InteractionStateObserver } from "../src/browser-worker/state-observer";

function readyState(enabled = true): InteractionTargetState {
  return {
    visible: true,
    enabled,
    stable: true,
    box: { x: 40, y: 60, width: 160, height: 48 }
  };
}

function observer(states: InteractionTargetState[]): InteractionStateObserver {
  let index = 0;
  return {
    waitUntilReady: jest.fn(async () => states[Math.min(index++, states.length - 1)] ?? readyState())
  } as unknown as InteractionStateObserver;
}

function fakePage(): Page {
  return {
    mouse: {
      move: jest.fn(async () => undefined),
      click: jest.fn(async () => undefined)
    }
  } as unknown as Page;
}

function pointerDriver(): PointerDriver & { moveTo: jest.Mock; click: jest.Mock; drag: jest.Mock } {
  return {
    moveTo: jest.fn(async () => undefined),
    click: jest.fn(async () => undefined),
    drag: jest.fn(async () => undefined)
  };
}

describe("InteractionEngine hover and scroll", () => {
  it("verifies hover outcome after readiness through the pointer driver", async () => {
    const evaluate = jest.fn(async () => true);
    const locator = {
      scrollIntoViewIfNeeded: jest.fn(async () => undefined),
      evaluate
    } as unknown as Locator;
    const pointer = pointerDriver();
    const engine = new InteractionEngine(fakePage(), undefined, observer([readyState()]), pointer);

    const result = await engine.hover(locator, {
      attempts: 1,
      seed: "hover-menu",
      verifyTimeoutMs: 0
    });

    expect(result.success).toBe(true);
    expect(pointer.moveTo).toHaveBeenCalledTimes(1);
    expect(pointer.moveTo).toHaveBeenCalledWith(result.targetPoint);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.trace[0]).toEqual(expect.objectContaining({
      seed: "hover-menu:1",
      readinessPolicy: "visible-enabled-stable",
      outcomeExpectation: "locator-hovered"
    }));
  });

  it("scrolls first and then verifies visible stable state without requiring enabled", async () => {
    const scrollIntoViewIfNeeded = jest.fn(async () => undefined);
    const isVisible = jest.fn(async () => true);
    const locator = {
      scrollIntoViewIfNeeded,
      isVisible
    } as unknown as Locator;
    const engine = new InteractionEngine(fakePage(), undefined, observer([readyState(false)]));

    const result = await engine.scrollIntoView(locator, {
      attempts: 1,
      seed: "scroll-section",
      verifyTimeoutMs: 0
    });

    expect(result.success).toBe(true);
    expect(scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
    expect(isVisible).toHaveBeenCalledTimes(1);
    expect(result.trace[0]).toEqual(expect.objectContaining({
      seed: "scroll-section:1",
      readinessPolicy: "visible-stable",
      outcomeExpectation: "locator-visible"
    }));
  });
});
