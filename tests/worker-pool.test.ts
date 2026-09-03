import { EventBus } from "../src/event-bus";
import { WorkerMock } from "../src/mocks";
import { WorkerPool } from "../src/worker-pool";

describe("WorkerPool", () => {
  it("assigns and releases a worker", () => {
    const pool = new WorkerPool(new EventBus());
    const worker = new WorkerMock("w1");

    pool.addWorker(worker);
    const id = pool.assignTask({ id: "t1" } as any);

    expect(id).toBe("w1");
    expect(pool.getAvailableWorkers()).toBe(0);

    pool.releaseWorker("w1");
    expect(pool.getAvailableWorkers()).toBe(1);
  });
});