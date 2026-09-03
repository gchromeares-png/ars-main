import { Injectable } from "@angular/core";

interface BrowserPreviewTask {
  id: string;
  config: {
    name: string;
    shopId?: string;
    data?: Record<string, unknown>;
  };
  state: string;
  retries: number;
  maxRetries: number;
  lastError?: string;
}

@Injectable({ providedIn: "root" })
export class ElectronService {
  private readonly previewProfiles: any[] = [];
  private readonly previewShops: any[] = [];
  private readonly previewTasks: BrowserPreviewTask[] = [];

  private get api(): any | undefined {
    return (window as any).ares;
  }

  getProfiles(): Promise<any> {
    if (this.api) return this.api.getProfiles();
    return Promise.resolve({ success: true, profiles: this.previewProfiles });
  }

  saveProfile(profile: unknown): Promise<any> {
    if (this.api) return this.api.saveProfile(profile);

    const savedProfile = profile as { id?: string };
    const index = this.previewProfiles.findIndex(item => item.id === savedProfile.id);
    if (index >= 0) this.previewProfiles[index] = profile;
    else this.previewProfiles.push(profile);

    return Promise.resolve({ success: true, profile });
  }

  deleteProfile(profileId: string): Promise<any> {
    if (this.api) return this.api.deleteProfile(profileId);

    const index = this.previewProfiles.findIndex(item => item.id === profileId);
    if (index >= 0) this.previewProfiles.splice(index, 1);
    return Promise.resolve({ success: true });
  }

  getShops(): Promise<any> {
    if (this.api) return this.api.getShops();
    return Promise.resolve({ success: true, shops: this.previewShops });
  }

  registerShop(config: unknown): Promise<any> {
    if (this.api) return this.api.registerShop(config);

    const shop = config as { id?: string; name?: string; baseUrl?: string; platform?: string };
    const normalizedShop = {
      ...shop,
      name: shop.name || shop.id,
      platform: shop.platform || "shopify"
    };
    const index = this.previewShops.findIndex(item => item.id === shop.id);
    if (index >= 0) this.previewShops[index] = normalizedShop;
    else this.previewShops.push(normalizedShop);

    return Promise.resolve({ success: true });
  }

  createTask(config: unknown): Promise<any> {
    if (this.api) return this.api.createTask(config);

    const taskConfig = config as { id?: string; name?: string; shopId?: string; data?: Record<string, unknown> };
    const task: BrowserPreviewTask = {
      id: taskConfig.id || `preview_task_${Date.now()}`,
      config: {
        name: taskConfig.name || "Preview Task",
        shopId: taskConfig.shopId,
        data: {
          ...(taskConfig.data ?? {}),
          liveChallengeStatus: "Browser-Vorschau: echtes Captcha-Handling läuft nur in Electron.",
          liveChallengeType: "preview"
        }
      },
      state: "QUEUED",
      retries: 0,
      maxRetries: 0
    };

    this.previewTasks.push(task);
    return Promise.resolve({ success: true, taskId: task.id, task });
  }

  startTask(taskId: string): Promise<any> {
    if (this.api) return this.api.startTask(taskId);

    const task = this.previewTasks.find(item => item.id === taskId);
    if (task) {
      task.state = "RUNNING";
      task.config.data = {
        ...(task.config.data ?? {}),
        liveChallengeStatus: "Browser-Vorschau aktiv. Für echte Sessions Electron starten.",
        liveChallengeType: "preview"
      };
    }
    return Promise.resolve({ success: true, task });
  }

  pauseTask(taskId: string): Promise<any> {
    if (this.api) return this.api.pauseTask(taskId);

    const task = this.previewTasks.find(item => item.id === taskId);
    if (task) {
      task.state = "PAUSED";
      task.config.data = {
        ...(task.config.data ?? {}),
        liveChallengeStatus: "Browser-Vorschau pausiert. Fortsetzen setzt den Task zurück in die Queue.",
        liveChallengeType: "preview"
      };
    }
    return Promise.resolve({ success: true, task });
  }

  resumeTask(taskId: string): Promise<any> {
    if (this.api) return this.api.resumeTask(taskId);

    const task = this.previewTasks.find(item => item.id === taskId);
    if (task) {
      task.state = "QUEUED";
      task.config.data = {
        ...(task.config.data ?? {}),
        liveChallengeStatus: "Browser-Vorschau fortgesetzt. Echter Task-Resume läuft nur in Electron.",
        liveChallengeType: "preview"
      };
    }
    return Promise.resolve({ success: true, task });
  }

  stopTask(taskId: string): Promise<any> {
    if (this.api) return this.api.stopTask(taskId);

    const task = this.previewTasks.find(item => item.id === taskId);
    if (task) task.state = "CANCELLED";
    return Promise.resolve({ success: true, task });
  }

  getTaskStatus(taskId: string): Promise<any> {
    if (this.api) return this.api.getTaskStatus(taskId);

    const task = this.previewTasks.find(item => item.id === taskId);
    return Promise.resolve(
      task
        ? { success: true, status: task.state, task }
        : { success: false, error: `Task ${taskId} not found.` }
    );
  }

  getTaskList(): Promise<any> {
    if (this.api) return this.api.getTaskList();
    return Promise.resolve({ success: true, tasks: this.previewTasks });
  }

  getSystemStatus(): Promise<any> {
    if (this.api) return this.api.getSystemStatus();

    return Promise.resolve({
      success: true,
      availableWorkers: 0,
      shopCount: this.previewShops.length,
      taskCount: this.previewTasks.length,
      captchaProvider: "CapMonster",
      captchaApiKeyConfigured: false,
      liveChallengeSupport: ["turnstile", "recaptcha", "shopify-checkpoint"],
      electronNodeVersion: undefined,
      systemNodeRequirement: ">=20",
      systemNode: {
        executable: "browser-preview",
        version: "n/a",
        ok: true
      },
      browserPreview: true
    });
  }

  onTaskStatusUpdate(callback: (task: unknown) => void): () => void {
    if (this.api?.onTaskStatusUpdate) {
      const unsub = this.api.onTaskStatusUpdate(callback);
      return () => {
        if (typeof unsub === "function") {
          unsub();
        } else if (this.api?.removeTaskStatusListener) {
          this.api.removeTaskStatusListener(callback);
        }
      };
    }

    return () => undefined;
  }
}
