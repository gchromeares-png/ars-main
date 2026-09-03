import type { Task } from "../models";
import type { AresProfile } from "../profiles/models";
import type { ShopifyRuntimeShop } from "./runtime-types";
import type { BrowserWorkerHealth } from "./types";

export type BrowserWorkerHealthWire = Omit<BrowserWorkerHealth, "startedAt"> & { startedAt: string };

export interface ExecuteTaskRequest {
  type: "execute";
  requestId: string;
  task: Task;
  shop: ShopifyRuntimeShop;
  profile: AresProfile;
}

export interface CancelTaskRequest {
  type: "cancel";
  requestId: string;
  taskId: string;
}

export interface HealthRequest {
  type: "health";
  requestId: string;
}

export interface ShutdownRequest {
  type: "shutdown";
  requestId: string;
}

export type BrowserWorkerRequest = ExecuteTaskRequest | CancelTaskRequest | HealthRequest | ShutdownRequest;

export interface ReadyMessage {
  type: "ready";
  nodeVersion: string;
  pid: number;
}

export interface ExecuteTaskResponse {
  type: "execute-result";
  requestId: string;
  success: boolean;
  taskPatch: {
    config: Task["config"];
    lastError?: string;
  };
}

export interface TaskUpdateResponse {
  type: "task-update";
  taskId: string;
  taskPatch: {
    config: Task["config"];
    lastError?: string;
  };
}

export interface HealthResponse {
  type: "health-result";
  requestId: string;
  health: BrowserWorkerHealthWire;
  pid: number;
  nodeVersion: string;
}

export interface AckResponse {
  type: "ack";
  requestId: string;
}

export interface ErrorResponse {
  type: "error";
  requestId?: string;
  error: string;
}

export type BrowserWorkerResponse = ReadyMessage | ExecuteTaskResponse | TaskUpdateResponse | HealthResponse | AckResponse | ErrorResponse;
