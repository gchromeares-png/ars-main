import { Injectable } from "@angular/core";

@Injectable({ providedIn: "root" })
export class ElectronService {
  getProfiles(): Promise<any> {
    return window.ares.getProfiles();
  }

  saveProfile(profile: unknown): Promise<any> {
    return window.ares.saveProfile(profile);
  }

  deleteProfile(profileId: string): Promise<any> {
    return window.ares.deleteProfile(profileId);
  }

  getShops(): Promise<any> {
    return window.ares.getShops();
  }

  registerShop(config: unknown): Promise<any> {
    return window.ares.registerShop(config);
  }

  createTask(config: unknown): Promise<any> {
    return window.ares.createTask(config);
  }

  startTask(taskId: string): Promise<any> {
    return window.ares.startTask(taskId);
  }

  stopTask(taskId: string): Promise<any> {
    return window.ares.stopTask(taskId);
  }

  getTaskStatus(taskId: string): Promise<any> {
    return window.ares.getTaskStatus(taskId);
  }

  getTaskList(): Promise<any> {
    return window.ares.getTaskList();
  }

  getSystemStatus(): Promise<any> {
    return window.ares.getSystemStatus();
  }

  onTaskStatusUpdate(callback: (task: unknown) => void): () => void {
    const unsub = window.ares?.onTaskStatusUpdate?.(callback);
    return () => {
      if (typeof unsub === "function") {
        unsub();
      } else if (window.ares?.removeTaskStatusListener) {
        window.ares.removeTaskStatusListener(callback);
      }
    };
  }
}
