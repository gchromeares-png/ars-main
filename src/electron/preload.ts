import { contextBridge, ipcRenderer } from "electron";

const taskStatusListeners = new Map<Function, (_event: Electron.IpcRendererEvent, payload: unknown) => void>();

const api = {
  getProfiles: () => ipcRenderer.invoke("get-profiles"),
  saveProfile: (profile: unknown) => ipcRenderer.invoke("save-profile", profile),
  deleteProfile: (profileId: string) => ipcRenderer.invoke("delete-profile", profileId),
  getShops: () => ipcRenderer.invoke("get-shops"),
  registerShop: (config: unknown) => ipcRenderer.invoke("register-shop", config),
  createTask: (config: unknown) => ipcRenderer.invoke("create-task", config),
  startTask: (taskId: string) => ipcRenderer.invoke("start-task", taskId),
  stopTask: (taskId: string) => ipcRenderer.invoke("stop-task", taskId),
  getTaskStatus: (taskId: string) => ipcRenderer.invoke("get-task-status", taskId),
  getTaskList: () => ipcRenderer.invoke("get-task-list"),
  getSystemStatus: () => ipcRenderer.invoke("get-system-status"),
  onTaskStatusUpdate: (callback: (task: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    taskStatusListeners.set(callback, listener);
    ipcRenderer.on("task-status-update", listener);
    return () => {
      ipcRenderer.removeListener("task-status-update", listener);
      taskStatusListeners.delete(callback);
    };
  },
  removeTaskStatusListener: (callback?: (task: unknown) => void) => {
    if (callback && taskStatusListeners.has(callback)) {
      const listener = taskStatusListeners.get(callback)!;
      ipcRenderer.removeListener("task-status-update", listener);
      taskStatusListeners.delete(callback);
    } else {
      ipcRenderer.removeAllListeners("task-status-update");
      taskStatusListeners.clear();
    }
  }
};

contextBridge.exposeInMainWorld("ares", api);

export type AresApi = typeof api;
