import { TaskRegistry } from "../src/task-registry";
import { TaskRepositoryMock } from "../src/mocks";
import { TaskState } from "../src/models";

describe("TaskRegistry", () => {
  it("creates and retrieves tasks", () => {
    const r = new TaskRegistry(new TaskRepositoryMock());
    const task = r.createTask({ id: "1", name: "test" });

    expect(r.getTask("1")).toBe(task);
    expect(task.state).toBe(TaskState.CREATED);
  });

  it("returns the most recently updated tasks first for the Watch UI", () => {
    const r = new TaskRegistry(new TaskRepositoryMock());
    const oldTask = r.createTask({ id: "old", name: "old" });
    const freshTask = r.createTask({ id: "fresh", name: "fresh" });

    oldTask.updatedAt = new Date("2026-09-05T10:00:00.000Z");
    freshTask.updatedAt = new Date("2026-09-05T11:00:00.000Z");

    expect(r.getAllTasks().map(task => task.id)).toEqual(["fresh", "old"]);
  });
});