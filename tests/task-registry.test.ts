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
});