import type { Locator } from "patchright";
import { SemanticCheckoutTraceRecorder } from "../src/browser-worker/semantic-checkout-observability";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { semanticTarget } from "../src/browser-worker/semantic-target";

interface MutableFakeLocator extends Locator {
  __set(value: string): void;
}

function fakeLocator(initialValue = "", enabled = true): MutableFakeLocator {
  let value = initialValue;
  return {
    isVisible: async () => true,
    isEnabled: async () => enabled,
    inputValue: async () => value,
    __set: (next: string) => { value = next; }
  } as unknown as MutableFakeLocator;
}

const semanticResolution = {
  resolverSource: { intent: "standard-metadata" as const, context: "standard-metadata" as const },
  confidence: 1
};

describe("Semantic checkout observability", () => {
  it("records every V1 result without serializing profile values", async () => {
    const recorder = new SemanticCheckoutTraceRecorder("explicit-billing");
    const interactions = {
      fill: async (locator: MutableFakeLocator, value: string) => locator.__set(value),
      select: async (locator: MutableFakeLocator, value: string) => locator.__set(value)
    } as any;
    const resolver = { resolve: jest.fn() } as any;
    const autofill = new SemanticFieldAutofill(undefined as any, interactions, resolver, recorder);

    const shippingCity = semanticTarget("city", "shipping");
    const billingCity = semanticTarget("city", "billing");
    const shippingPostal = semanticTarget("postalCode", "shipping");
    const shippingPhone = semanticTarget("phone", "shipping");

    const fillTarget = fakeLocator();
    await expect(autofill.fillLocator(shippingCity, fillTarget, "Hamburg", {
      kind: "semantic",
      resolution: semanticResolution
    })).resolves.toBe(true);

    // Same concrete target is complete on the second pass.
    await expect(autofill.fillLocator(shippingCity, fillTarget, "Hamburg", {
      kind: "semantic",
      resolution: semanticResolution
    })).resolves.toBe(true);

    await expect(autofill.fillLocator(billingCity, fakeLocator("", false), "Berlin", {
      kind: "semantic",
      resolution: semanticResolution
    })).resolves.toBe(false);

    await expect(autofill.fillLocator(shippingPostal, fakeLocator(), undefined, {
      kind: "semantic",
      resolution: semanticResolution
    })).resolves.toBe(false);

    await expect(autofill.fillLocator(semanticTarget("unknown", "unknown"), fakeLocator(), undefined, {
      kind: "semantic",
      resolution: { resolverSource: { intent: "unknown", context: "unknown" }, confidence: 0 }
    })).resolves.toBe(false);

    // No explicit trace metadata means an external locator write is classified as
    // deterministic shop fallback once a recorder is attached.
    await expect(autofill.fillLocator(shippingPhone, fakeLocator(), "+49 40 000000")).resolves.toBe(true);

    const failing = new SemanticFieldAutofill(
      undefined as any,
      { fill: async () => { throw new Error("synthetic write failure"); } } as any,
      resolver,
      recorder
    );
    await expect(failing.fillLocator(semanticTarget("firstName", "shipping"), fakeLocator(), "Max", {
      kind: "semantic",
      resolution: semanticResolution
    })).rejects.toThrow("synthetic write failure");

    const snapshot = recorder.snapshot();
    const results = new Set(snapshot.events.map(event => event.result));
    expect(results).toEqual(new Set([
      "filled",
      "missing-value",
      "unresolved",
      "non-interactive",
      "already-complete",
      "write-failed",
      "fallback-filled"
    ]));

    expect(snapshot.events.every(event => event.billingMode === "explicit-billing")).toBe(true);
    expect(snapshot.events.every(event => typeof event.timestamp === "string" && event.timestamp.length > 0)).toBe(true);

    const eventKeys = Object.keys(snapshot.events[0] ?? {}).sort();
    expect(eventKeys).toEqual([
      "action",
      "billingMode",
      "confidence",
      "context",
      "intent",
      "resolverSource",
      "result",
      "targetKey",
      "timestamp",
      "valueAvailable"
    ].sort());

    // Values pass through AutoFill, but the trace must never contain them.
    const serialized = JSON.stringify(snapshot);
    for (const pii of ["Hamburg", "Berlin", "+49 40 000000", "Max"]) {
      expect(serialized).not.toContain(pii);
    }
  });

  it("caps trace growth without changing the schema", () => {
    const recorder = new SemanticCheckoutTraceRecorder("same-as-shipping", 2);
    for (let index = 0; index < 4; index++) {
      recorder.record({
        target: semanticTarget("city", "shipping"),
        resolverSource: { intent: "lexical", context: "lexical" },
        confidence: 0.95,
        valueAvailable: true,
        action: "write",
        result: "filled"
      });
    }

    expect(recorder.snapshot()).toEqual(expect.objectContaining({
      schemaVersion: 1,
      droppedEvents: 2,
      events: expect.any(Array)
    }));
    expect(recorder.snapshot().events).toHaveLength(2);
  });
});
