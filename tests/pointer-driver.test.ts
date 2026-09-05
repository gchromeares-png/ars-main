import { GhostCursorPointerDriver } from "../src/browser-worker/pointer-driver";

describe("PointerDriver", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps click as a direct pointer operation", async () => {
    const mouse = {
      move: jest.fn(async () => undefined),
      down: jest.fn(async () => undefined),
      up: jest.fn(async () => undefined),
      click: jest.fn(async () => undefined)
    };
    const driver = new GhostCursorPointerDriver({ mouse } as any);

    await driver.click({ x: 42, y: 24 });

    expect(mouse.click).toHaveBeenCalledTimes(1);
    expect(mouse.click).toHaveBeenCalledWith(42, 24, { button: "left", clickCount: 1 });
    expect(mouse.move).not.toHaveBeenCalled();
    expect(mouse.down).not.toHaveBeenCalled();
    expect(mouse.up).not.toHaveBeenCalled();
  });

  it("stages drag points across the requested duration", async () => {
    jest.useFakeTimers();
    const events: string[] = [];
    const mouse = {
      move: jest.fn(async (x: number, y: number) => { events.push(`move:${x},${y}`); }),
      down: jest.fn(async () => { events.push("down"); }),
      up: jest.fn(async () => { events.push("up"); }),
      click: jest.fn(async () => undefined)
    };
    const driver = new GhostCursorPointerDriver({ mouse } as any);
    const pending = driver.drag([
      { x: 10, y: 10 },
      { x: 20, y: 15 },
      { x: 30, y: 20 },
      { x: 40, y: 25 }
    ], 300);

    await Promise.resolve();
    expect(events).toEqual(["move:10,10", "down"]);

    await jest.advanceTimersByTimeAsync(99);
    expect(events).toEqual(["move:10,10", "down"]);
    await jest.advanceTimersByTimeAsync(1);
    expect(events).toContain("move:20,15");
    await jest.advanceTimersByTimeAsync(100);
    expect(events).toContain("move:30,20");
    await jest.advanceTimersByTimeAsync(100);
    await pending;

    expect(events).toEqual([
      "move:10,10",
      "down",
      "move:20,15",
      "move:30,20",
      "move:40,25",
      "up"
    ]);
  });

  it("always releases the pointer when a drag move fails", async () => {
    const mouse = {
      move: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("move failed")),
      down: jest.fn(async () => undefined),
      up: jest.fn(async () => undefined),
      click: jest.fn(async () => undefined)
    };
    const driver = new GhostCursorPointerDriver({ mouse } as any);

    await expect(driver.drag([{ x: 1, y: 1 }, { x: 2, y: 2 }], 0)).rejects.toThrow("move failed");
    expect(mouse.down).toHaveBeenCalledTimes(1);
    expect(mouse.up).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid drag inputs before pressing the pointer", async () => {
    const mouse = {
      move: jest.fn(async () => undefined),
      down: jest.fn(async () => undefined),
      up: jest.fn(async () => undefined),
      click: jest.fn(async () => undefined)
    };
    const driver = new GhostCursorPointerDriver({ mouse } as any);

    await expect(driver.drag([{ x: 1, y: 1 }])).rejects.toThrow(/at least two points/);
    await expect(driver.drag([{ x: 1, y: 1 }, { x: Number.NaN, y: 2 }])).rejects.toThrow(/finite numbers/);
    expect(mouse.down).not.toHaveBeenCalled();
  });
});
