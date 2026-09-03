import { Component, OnDestroy, OnInit } from "@angular/core";
import { ElectronService } from "./services/electron.service";
import { TaskState } from "../models";

interface ProfileView {
  id: string;
  name: string;
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  address: {
    address1: string;
    address2?: string;
    postalCode: string;
    city: string;
    countryCode: string;
  };
  proxy?: {
    protocol?: "http" | "https" | "socks5";
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };
  browser?: {
    headless?: boolean;
    userAgent?: string;
  };
}

interface ShopView {
  id: string;
  name: string;
  baseUrl: string;
  platform: string;
}

interface TaskView {
  id: string;
  config: {
    name: string;
    shopId?: string;
    data?: Record<string, unknown>;
  };
  state: TaskState;
  retries?: number;
  maxRetries?: number;
  lastError?: string;
}

interface SystemNodeStatus {
  executable: string;
  version?: string;
  major?: number;
  ok: boolean;
  error?: string;
}

interface SystemStatus {
  availableWorkers: number;
  shopCount: number;
  taskCount: number;
  captchaProvider?: string;
  captchaApiKeyConfigured?: boolean;
  liveChallengeSupport?: string[];
  electronNodeVersion?: string;
  systemNodeRequirement?: string;
  systemNode?: SystemNodeStatus;
  browserPreview?: boolean;
}

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrls: ["./app.component.scss"]
})
export class AppComponent implements OnInit, OnDestroy {
  shops: ShopView[] = [];
  profiles: ProfileView[] = [];
  selectedProfileId = "";

  newProfile: ProfileView = {
    id: "",
    name: "",
    contact: {
      firstName: "",
      lastName: "",
      email: "",
      phone: ""
    },
    address: {
      address1: "",
      address2: "",
      postalCode: "",
      city: "",
      countryCode: "DE"
    },
    proxy: {
      protocol: "http",
      host: "",
      port: undefined,
      username: "",
      password: ""
    },
    browser: {
      headless: false,
      userAgent: ""
    }
  };
  tasks: TaskView[] = [];
  system: SystemStatus = {
    availableWorkers: 0,
    shopCount: 0,
    taskCount: 0,
    captchaProvider: "CapMonster",
    captchaApiKeyConfigured: false,
    liveChallengeSupport: [],
    systemNode: {
      executable: "node",
      ok: false
    }
  };

  newShop = {
    id: "",
    name: "",
    baseUrl: "",
    platform: "shopify"
  };

  taskName = "";
  selectedShopId = "";
  searchTerm = "";
  headless = false;
  error = "";
  info = "";

  private unsubscribeStatus?: () => void;

  constructor(private readonly electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.loadShops(),
      this.loadProfiles(),
      this.loadTasks(),
      this.loadSystemStatus()
    ]);

    this.unsubscribeStatus = this.electron.onTaskStatusUpdate(() => {
      void Promise.all([
        this.loadTasks(),
        this.loadSystemStatus()
      ]);
    });
  }

  ngOnDestroy(): void {
    this.unsubscribeStatus?.();
  }

  async loadProfiles(): Promise<void> {
    const result = await this.electron.getProfiles();
    if (result.success) {
      this.profiles = result.profiles;

      if (!this.selectedProfileId && this.profiles.length > 0) {
        this.selectedProfileId = this.profiles[0].id;
      }
    }
  }

  async saveProfile(): Promise<void> {
    this.error = "";
    this.info = "";

    const profile = this.newProfile;

    if (
      !profile.id.trim() ||
      !profile.name.trim() ||
      !profile.contact.firstName.trim() ||
      !profile.contact.lastName.trim() ||
      !profile.contact.email.trim() ||
      !profile.address.address1.trim() ||
      !profile.address.postalCode.trim() ||
      !profile.address.city.trim()
    ) {
      this.error = "Bitte Profilname, Kontakt und Adresse vollständig ausfüllen.";
      return;
    }

    const result = await this.electron.saveProfile({
      ...profile,
      id: profile.id.trim(),
      name: profile.name.trim(),
      contact: {
        ...profile.contact,
        firstName: profile.contact.firstName.trim(),
        lastName: profile.contact.lastName.trim(),
        email: profile.contact.email.trim(),
        phone: profile.contact.phone?.trim() || ""
      },
      address: {
        ...profile.address,
        address1: profile.address.address1.trim(),
        address2: profile.address.address2?.trim() || "",
        postalCode: profile.address.postalCode.trim(),
        city: profile.address.city.trim(),
        countryCode: profile.address.countryCode.trim().toUpperCase() || "DE"
      },
      proxy: profile.proxy?.host
        ? {
            ...profile.proxy,
            host: profile.proxy.host.trim(),
            username: profile.proxy.username?.trim() || "",
            password: profile.proxy.password || ""
          }
        : undefined
    });

    if (!result.success) {
      this.error = result.error;
      return;
    }

    this.info = "Profil gespeichert.";
    await this.loadProfiles();
  }

  async loadShops(): Promise<void> {
    const result = await this.electron.getShops();
    if (result.success) {
      this.shops = result.shops;
      if (!this.selectedShopId && this.shops.length > 0) {
        this.selectedShopId = this.shops[0].id;
      }
    }
  }

  async loadTasks(): Promise<void> {
    const result = await this.electron.getTaskList();
    if (result.success) {
      this.tasks = result.tasks;
    }
  }

  async loadSystemStatus(): Promise<void> {
    const result = await this.electron.getSystemStatus();
    if (result.success) {
      this.system = result;
    }
  }

  async registerShop(): Promise<void> {
    this.error = "";
    this.info = "";

    const id = this.newShop.id.trim();
    const baseUrl = this.newShop.baseUrl.trim();

    if (!id || !baseUrl) {
      this.error = "Shop-ID und Shop-URL sind erforderlich.";
      return;
    }

    const result = await this.electron.registerShop({
      ...this.newShop,
      id,
      name: this.newShop.name.trim() || id,
      baseUrl
    });

    if (!result.success) {
      this.error = result.error;
      return;
    }

    this.info = "Shop erfolgreich registriert.";
    this.newShop = { id: "", name: "", baseUrl: "", platform: "shopify" };

    await Promise.all([
      this.loadShops(),
      this.loadSystemStatus()
    ]);
  }

  async createTask(): Promise<void> {
    this.error = "";
    this.info = "";

    if (!this.taskName.trim() || !this.selectedShopId || !this.selectedProfileId) {
      this.error = "Task-Name, Shop und Profil sind erforderlich.";
      return;
    }

    const result = await this.electron.createTask({
      id: `task_${Date.now()}`,
      name: this.taskName.trim(),
      shopId: this.selectedShopId,
      data: {
        productCriteria: {
          searchTerm: this.searchTerm.trim()
        },
        browserConfig: {
          headless: this.headless
        },
        profileId: this.selectedProfileId || undefined
      }
    });

    if (!result.success) {
      this.error = result.error;
      return;
    }

    this.info = `Task ${result.taskId} erstellt.`;
    this.taskName = "";
    this.searchTerm = "";

    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus()
    ]);
  }

  async startTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.startTask(taskId);
    if (!result.success) {
      this.error = result.error;
    }
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus()
    ]);
  }

  async pauseTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.pauseTask(taskId);
    if (!result.success) {
      this.error = result.error;
    }
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus()
    ]);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.resumeTask(taskId);
    if (!result.success) {
      this.error = result.error;
    }
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus()
    ]);
  }

  async stopTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.stopTask(taskId);
    if (!result.success) {
      this.error = result.error;
    }
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus()
    ]);
  }

  getTaskProfileName(task: TaskView): string {
    const profileId = String(task.config.data?.["profileId"] ?? "");
    if (!profileId) return "kein Profil";
    return this.profiles.find(profile => profile.id === profileId)?.name ?? profileId;
  }

  getTaskCaptchaStatus(task: TaskView): string {
    const data = task.config.data ?? {};
    const value = data["liveChallengeStatus"] ?? data["captchaStatus"] ?? data["challengeStatus"];
    return value ? String(value) : "Kein aktueller Captcha-Status";
  }

  getTaskChallengeType(task: TaskView): string {
    const data = task.config.data ?? {};
    const value = data["liveChallengeType"] ?? data["captchaType"] ?? data["challengeType"];
    return value ? String(value) : "";
  }

  getCaptchaKeyStatusLabel(): string {
    return this.system.captchaApiKeyConfigured ? "API-Key gesetzt" : "API-Key fehlt";
  }

  getSupportedChallengeTypes(): string {
    return this.system.liveChallengeSupport?.length
      ? this.system.liveChallengeSupport.join(", ")
      : "turnstile, recaptcha, shopify-checkpoint";
  }

  getSystemNodeStatusLabel(): string {
    if (this.system.browserPreview) return "Browser-Vorschau";
    if (!this.system.systemNode) return "Node unbekannt";
    return this.system.systemNode.ok ? "NODE OK" : "NODE FEHLER";
  }

  getSystemNodeDetails(): string {
    if (this.system.browserPreview) {
      return "Echter Worker-Check läuft nur in Electron.";
    }

    const node = this.system.systemNode;
    if (!node) return "System Node konnte nicht geprüft werden.";

    const version = node.version || "unbekannt";
    const requirement = this.system.systemNodeRequirement || ">=20";
    const base = `${node.executable} ${version} · benötigt ${requirement}`;
    return node.ok ? base : `${base} · ${node.error || "Worker kann evtl. nicht starten."}`;
  }

  isSystemNodeOk(): boolean {
    return Boolean(this.system.browserPreview || this.system.systemNode?.ok);
  }

  isStartable(task: TaskView): boolean {
    return task.state === TaskState.QUEUED;
  }

  isPausable(task: TaskView): boolean {
    return [
      TaskState.QUEUED,
      TaskState.STARTING,
      TaskState.RUNNING,
      TaskState.PRODUCT_FOUND,
      TaskState.CART,
      TaskState.CHECKOUT,
      TaskState.RETRYING
    ].includes(task.state);
  }

  isResumable(task: TaskView): boolean {
    return task.state === TaskState.PAUSED;
  }

  isStoppable(task: TaskView): boolean {
    return [
      TaskState.STARTING,
      TaskState.RUNNING,
      TaskState.PRODUCT_FOUND,
      TaskState.CART,
      TaskState.CHECKOUT,
      TaskState.RETRYING,
      TaskState.PAUSED
    ].includes(task.state);
  }

  trackTask(_index: number, task: TaskView): string {
    return task.id;
  }

  trackShop(_index: number, shop: ShopView): string {
    return shop.id;
  }
}
