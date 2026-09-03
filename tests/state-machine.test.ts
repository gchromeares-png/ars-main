import { StateMachine } from "../src/state-machine";
import { TaskState } from "../src/models";

describe("StateMachine", () => {
  const sm = new StateMachine();

  it("allows valid transitions", () => {
    expect(sm.canTransition(TaskState.CREATED, TaskState.QUEUED)).toBe(true);
    expect(sm.canTransition(TaskState.QUEUED, TaskState.STARTING)).toBe(true);
    expect(sm.canTransition(TaskState.STARTING, TaskState.RUNNING)).toBe(true);
    expect(sm.canTransition(TaskState.CHECKOUT, TaskState.SUCCESS)).toBe(true);
  });

  it("allows pausing active or queued tasks and resuming to queued", () => {
    expect(sm.canTransition(TaskState.QUEUED, TaskState.PAUSED)).toBe(true);
    expect(sm.canTransition(TaskState.STARTING, TaskState.PAUSED)).toBe(true);
    expect(sm.canTransition(TaskState.RUNNING, TaskState.PAUSED)).toBe(true);
    expect(sm.canTransition(TaskState.PRODUCT_FOUND, TaskState.PAUSED)).toBe(true);
    expect(sm.canTransition(TaskState.CART, TaskState.PAUSED)).toBe(true);
    expect(sm.canTransition(TaskState.CHECKOUT, TaskState.PAUSED)).toBe(true);
    expect(sm.canTransition(TaskState.RETRYING, TaskState.PAUSED)).toBe(true);
    expect(sm.canTransition(TaskState.PAUSED, TaskState.QUEUED)).toBe(true);
    expect(sm.canTransition(TaskState.PAUSED, TaskState.CANCELLED)).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(sm.canTransition(TaskState.CREATED, TaskState.SUCCESS)).toBe(false);
    expect(sm.canTransition(TaskState.SUCCESS, TaskState.RUNNING)).toBe(false);
    expect(sm.canTransition(TaskState.PAUSED, TaskState.RUNNING)).toBe(false);
  });
});
