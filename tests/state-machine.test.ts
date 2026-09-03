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

  it("rejects invalid transitions", () => {
    expect(sm.canTransition(TaskState.CREATED, TaskState.SUCCESS)).toBe(false);
    expect(sm.canTransition(TaskState.SUCCESS, TaskState.RUNNING)).toBe(false);
  });
});