export interface TaskConfig {
  id: string;
  name: string;
  shopId?: string;
  maxRetries?: number;
  timeout?: number;
  data?: Record<string, unknown>;
}

export enum TaskState {
  CREATED = "CREATED",
  QUEUED = "QUEUED",
  STARTING = "STARTING",
  RUNNING = "RUNNING",
  PRODUCT_FOUND = "PRODUCT_FOUND",
  CART = "CART",
  CHECKOUT = "CHECKOUT",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
  RETRYING = "RETRYING"
}

export interface Task {
  id: string;
  config: TaskConfig;
  state: TaskState;
  createdAt: Date;
  updatedAt: Date;
  lastError?: string;
  retries: number;
  maxRetries: number;
}