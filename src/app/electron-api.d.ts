export {};

declare global {
  interface Window {
    ares: {
      getProfiles(): Promise<any>;
      saveProfile(profile: unknown): Promise<any>;
      deleteProfile(profileId: string): Promise<any>;
      getShops(): Promise<any>;
      registerShop(config: unknown): Promise<any>;
      createTask(config: unknown): Promise<any>;
      setPaymentSession(taskId: string, payment: unknown): Promise<any>;
      clearPaymentSession(taskId: string): Promise<any>;
      startTask(taskId: string): Promise<any>;
      pauseTask(taskId: string): Promise<any>;
      resumeTask(taskId: string): Promise<any>;
      stopTask(taskId: string): Promise<any>;
      getTaskStatus(taskId: string): Promise<any>;
      getTaskList(): Promise<any>;
      getTaskLogs(taskId: string, limit?: number): Promise<any>;
      getProductMonitorEvents(taskId: string, limit?: number): Promise<any>;
      getSystemStatus(): Promise<any>;
      onTaskStatusUpdate(callback: (task: unknown) => void): () => void;
      onProductMonitorUpdate(callback: (payload: unknown) => void): () => void;
      removeTaskStatusListener?(callback?: (task: unknown) => void): void;
      removeProductMonitorListener?(callback?: (payload: unknown) => void): void;
    };
  }
}
