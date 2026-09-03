import { Task, TaskConfig } from "../models";

export interface ITaskExecutor {
  execute(task: Task): Promise<boolean>;
  cancelTask?(taskId: string): Promise<void>;
  close?(): void | Promise<void>;
}

export interface IBrowserManager {
  launchBrowser(): Promise<void>;
  closeBrowser(): Promise<void>;
  navigateTo(url: string): Promise<void>;
  waitForSelector(selector: string, timeout?: number): Promise<void>;
}

export interface IShopAdapter {
  findProduct(task: Task): Promise<boolean>;
  addToCart(task: Task): Promise<boolean>;
  checkout(task: Task): Promise<boolean>;
}

export interface IProxyManager {
  getProxy(): Promise<string>;
  releaseProxy(proxy: string): void;
}

export interface ITaskRepository {
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | null>;
  findAll(): Promise<Task[]>;
  update(task: Task): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface IWorker {
  id: string;
  status: "idle" | "busy";
  currentTaskId?: string;
  run(task: Task): Promise<void>;
  stop(): void;
}

export interface TaskEvents {
  taskCreated: Task;
  taskUpdated: Task;
  taskDeleted: string;
  taskQueued: Task;
  taskStarted: Task;
  taskPaused: Task;
  taskCancelled: Task;
  taskResumed: Task;
  taskCompleted: Task;
  taskFailed: Task;
  taskRetrying: Task;
  workerAssigned: { taskId: string; workerId: string };
  workerReleased: { taskId: string; workerId: string };
  workerAdded: IWorker;
  workerRemoved: string;
}