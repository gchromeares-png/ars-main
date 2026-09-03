import { Component, OnDestroy, OnInit } from "@angular/core";
import { ElectronService } from "./services/electron.service";
import { TaskState } from "../models";
import { COMMERCE_PLATFORMS, CommercePlatform } from "../commerce/platforms";
import type { CheckoutPaymentSession, PaymentMethod } from "../payments/models";

type AppTab = "dashboard" | "monitor" | "tasks" | "profiles" | "shops";
type ProfileTab = "identity" | "address" | "browser" | "payment";

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
  paymentPreference?: {
    method?: PaymentMethod;
    label?: string;
  };
}

interface ShopView {
  id: string;
  name: string;
  baseUrl: string;
  platform: CommercePlatform;
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

interface TaskLogView {
  id?: number;
  taskId: string;
  event: string;
  state?: TaskState;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string | Date;
}

interface SystemNodeStatus {
  executable: string;
  version?: string;
  major?: number;
  ok: boolean;
  error?: string;
}

interface PersistenceStatus {
  type: string;
  ready: boolean;
  error?: string;
}

interface SystemStatus {
  availableWorkers: number;
  shopCount: number;
  taskCount: number;
  commercePlatforms?: CommercePlatform[];
  commerceExecutorPlatforms?: CommercePlatform[];
  commerceMonitorReady?: boolean;
  captchaProvider?: string;
  captchaApiKeyConfigured?: boolean;
  liveChallengeSupport?: string[];
  electronNodeVersion?: string;
  systemNodeRequirement?: string;
  systemNode?: SystemNodeStatus;
  persistence?: PersistenceStatus;
  browserPreview?: boolean;
  browserWorkerPool?: unknown;
}

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrls: ["./app.component.scss"]
})
export class AppComponent implements OnInit, OnDestroy {
  activeTab: AppTab = "dashboard";
  profileTab: ProfileTab = "identity";

  shops: ShopView[] = [];
  profiles: ProfileView[] = [];
  selectedProfileId = "";
  selectedShopId = "";
  selectedMonitorShopId = "";
  commercePlatforms: CommercePlatform[] = [...COMMERCE_PLATFORMS];
  executorPlatforms: CommercePlatform[] = ["shopify"];

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
    },
    paymentPreference: {
      method: "card",
      label: ""
    }
  };

  newShop: { id: string; name: string; baseUrl: string; platform: CommercePlatform } = {
    id: "",
    name: "",
    baseUrl: "",
    platform: "shopify"
  };

  tasks: TaskView[] = [];
  taskLogs: Record<string, TaskLogView[]> = {};
  expandedTaskLogId = "";
  system: SystemStatus = {
    availableWorkers: 0,
    shopCount: 0,
    taskCount: 0,
    commercePlatforms: [...COMMERCE_PLATFORMS],
    commerceExecutorPlatforms: ["shopify"],
    commerceMonitorReady: true,
    captchaProvider: "CapMonster",
    captchaApiKeyConfigured: false,
    liveChallengeSupport: [],
    systemNode: {
      executable: "node",
      ok: false
    }
  };

  taskName = "";
  searchTerm = "";
  headless = false;

  monitorName = "";
  monitorSearchTerm = "";
  monitorIntervalSeconds = 30;

  taskPaymentEnabled = false;
  taskPaymentMethod: PaymentMethod = "card";
  taskPaymentLabel = "";
  sessionCardHolderName = "";
  sessionCardNumber = "";
  sessionCardExpiry = "";
  sessionCardSecurityCode = "";

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

    this.syncPaymentPreference();
    this.unsubscribeStatus = this.electron.onTaskStatusUpdate(() => {
      const expandedTaskLogId = this.expandedTaskLogId;
      void Promise.all([
        this.loadTasks(),
        this.loadSystemStatus(),
        expandedTaskLogId ? this.loadTaskLogs(expandedTaskLogId) : Promise.resolve()
      ]);
    });
  }

  ngOnDestroy(): void {
    this.unsubscribeStatus?.();
  }

  setTab(tab: AppTab): void {
    this.activeTab = tab;
    this.error = "";
    this.info = "";
  }

  setProfileTab(tab: ProfileTab): void {
    this.profileTab = tab;
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
        : undefined,
      paymentPreference: {
        method: profile.paymentPreference?.method || "card",
        label: profile.paymentPreference?.label?.trim() || undefined
      }
    });

    if (!result.success) {
      this.error = result.error;
      return;
    }

    this.info = "Profil gespeichert. Zahlungspräferenz gespeichert; Kartendaten werden niemals im Profil gespeichert.";
    await this.loadProfiles();
  }

  async loadShops(): Promise<void> {
    const result = await this.electron.getShops();
    if (result.success) {
      this.shops = result.shops;
      if (Array.isArray(result.platforms) && result.platforms.length) {
        this.commercePlatforms = result.platforms;
      }
      if (Array.isArray(result.executorPlatforms)) {
        this.executorPlatforms = result.executorPlatforms;
      }
      if (!this.selectedShopId && this.shops.length > 0) this.selectedShopId = this.shops[0].id;
      if (!this.selectedMonitorShopId && this.shops.length > 0) this.selectedMonitorShopId = this.shops[0].id;
    }
  }

  async loadTasks(): Promise<void> {
    const result = await this.electron.getTaskList();
    if (result.success) this.tasks = result.tasks;
  }

  async loadTaskLogs(taskId: string): Promise<void> {
    const result = await this.electron.getTaskLogs(taskId, 100);
    if (result.success) {
      this.taskLogs[taskId] = result.logs;
    } else {
      this.error = result.error || "Task-Verlauf konnte nicht geladen werden.";
    }
  }

  async toggleTaskLogs(taskId: string): Promise<void> {
    if (this.expandedTaskLogId === taskId) {
      this.expandedTaskLogId = "";
      return;
    }
    this.expandedTaskLogId = taskId;
    await this.loadTaskLogs(taskId);
  }

  async loadSystemStatus(): Promise<void> {
    const result = await this.electron.getSystemStatus();
    if (result.success) {
      this.system = result;
      if (Array.isArray(result.commercePlatforms) && result.commercePlatforms.length) {
        this.commercePlatforms = result.commercePlatforms;
      }
      if (Array.isArray(result.commerceExecutorPlatforms)) {
        this.executorPlatforms = result.commerceExecutorPlatforms;
      }
    }
  }

  async registerShop(): Promise<void> {
    this.error = "";
    this.info = "";

    const id = this.newShop.id.trim();
    const baseUrl = this.newShop.baseUrl.trim();
    const platform = this.newShop.platform;
    if (!id || !baseUrl) {
      this.error = "Shop-ID und Shop-URL sind erforderlich.";
      return;
    }

    const result = await this.electron.registerShop({
      ...this.newShop,
      id,
      name: this.newShop.name.trim() || id,
      baseUrl,
      platform
    });

    if (!result.success) {
      this.error = result.error;
      return;
    }

    this.info = result.executorReady
      ? `${this.getPlatformLabel(platform)} Shop registriert · Browser-Executor bereit.`
      : `${this.getPlatformLabel(platform)} Shop registriert · Monitor-Adapter kann unabhängig verfügbar sein.`;
    this.newShop = { id: "", name: "", baseUrl: "", platform };
    await Promise.all([this.loadShops(), this.loadSystemStatus()]);
  }

  async createMonitorTask(): Promise<void> {
    this.error = "";
    this.info = "";

    if (!this.monitorName.trim() || !this.selectedMonitorShopId || !this.monitorSearchTerm.trim()) {
      this.error = "Monitor-Name, Shop und Produkt/Keyword sind erforderlich.";
      return;
    }

    const intervalSeconds = Math.max(1, Math.floor(Number(this.monitorIntervalSeconds) || 30));
    const result = await this.electron.createTask({
      id: `monitor_${Date.now()}`,
      name: this.monitorName.trim(),
      shopId: this.selectedMonitorShopId,
      data: {
        productCriteria: {
          searchTerm: this.monitorSearchTerm.trim()
        },
        monitorIntervalMs: intervalSeconds * 1_000
      }
    });

    if (!result.success) {
      this.error = result.error;
      return;
    }

    this.info = `Monitor ${result.taskId} erstellt. Unter Tasks auf Start klicken.`;
    this.monitorName = "";
    this.monitorSearchTerm = "";
    await Promise.all([this.loadTasks(), this.loadSystemStatus()]);
  }

  async createTask(): Promise<void> {
    this.error = "";
    this.info = "";

    if (!this.taskName.trim() || !this.selectedShopId || !this.selectedProfileId) {
      this.error = "Task-Name, Shop und Profil sind erforderlich.";
      return;
    }

    const taskId = `task_${Date.now()}`;
    const result = await this.electron.createTask({
      id: taskId,
      name: this.taskName.trim(),
      shopId: this.selectedShopId,
      data: {
        searchTerm: this.searchTerm.trim(),
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

    if (this.taskPaymentEnabled) {
      const paymentResult = await this.electron.setPaymentSession(taskId, this.buildPaymentSession());
      if (!paymentResult.success) {
        this.error = `Task erstellt, aber Zahlungs-Session konnte nicht gesetzt werden: ${paymentResult.error}`;
      }
    }

    this.info = this.taskPaymentEnabled
      ? `Browser-Task ${result.taskId} erstellt · Zahlungsdaten liegen nur im RAM bis Task-Ende.`
      : `Browser-Task ${result.taskId} erstellt.`;
    this.taskName = "";
    this.searchTerm = "";
    this.clearSensitivePaymentInputs();
    await Promise.all([this.loadTasks(), this.loadSystemStatus()]);
  }

  syncPaymentPreference(): void {
    const profile = this.profiles.find(item => item.id === this.selectedProfileId);
    if (!profile?.paymentPreference?.method) return;
    this.taskPaymentMethod = profile.paymentPreference.method;
    this.taskPaymentLabel = profile.paymentPreference.label || "";
  }

  private buildPaymentSession(): CheckoutPaymentSession {
    const session: CheckoutPaymentSession = {
      method: this.taskPaymentMethod,
      label: this.taskPaymentLabel.trim() || undefined
    };
    if (this.taskPaymentMethod === "card") {
      session.card = {
        holderName: this.sessionCardHolderName.trim() || undefined,
        cardNumber: this.sessionCardNumber.trim() || undefined,
        expiry: this.sessionCardExpiry.trim() || undefined,
        securityCode: this.sessionCardSecurityCode.trim() || undefined
      };
    }
    return session;
  }

  private clearSensitivePaymentInputs(): void {
    this.sessionCardNumber = "";
    this.sessionCardExpiry = "";
    this.sessionCardSecurityCode = "";
  }

  async startTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.startTask(taskId);
    if (!result.success) this.error = result.error;
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus(),
      this.expandedTaskLogId === taskId ? this.loadTaskLogs(taskId) : Promise.resolve()
    ]);
  }

  async pauseTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.pauseTask(taskId);
    if (!result.success) this.error = result.error;
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus(),
      this.expandedTaskLogId === taskId ? this.loadTaskLogs(taskId) : Promise.resolve()
    ]);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.resumeTask(taskId);
    if (!result.success) this.error = result.error;
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus(),
      this.expandedTaskLogId === taskId ? this.loadTaskLogs(taskId) : Promise.resolve()
    ]);
  }

  async stopTask(taskId: string): Promise<void> {
    this.error = "";
    await this.electron.clearPaymentSession(taskId);
    const result = await this.electron.stopTask(taskId);
    if (!result.success) this.error = result.error;
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus(),
      this.expandedTaskLogId === taskId ? this.loadTaskLogs(taskId) : Promise.resolve()
    ]);
  }

  isMonitorTask(task: TaskView): boolean {
    const criteria = task.config.data?.["productCriteria"];
    return Boolean(criteria && typeof criteria === "object");
  }

  getTaskKind(task: TaskView): string {
    return this.isMonitorTask(task) ? "MONITOR" : "BROWSER";
  }

  getTaskProfileName(task: TaskView): string {
    if (this.isMonitorTask(task)) return "nicht benötigt";
    const profileId = String(task.config.data?.["profileId"] ?? "");
    if (!profileId) return "kein Profil";
    return this.profiles.find(profile => profile.id === profileId)?.name ?? profileId;
  }

  getTaskCaptchaStatus(task: TaskView): string {
    if (this.isMonitorTask(task)) return "Monitor nutzt keinen Browser-Challenge-Flow";
    const data = task.config.data ?? {};
    const value = data["liveChallengeStatus"] ?? data["captchaStatus"] ?? data["challengeStatus"];
    return value ? String(value) : "Kein aktueller Captcha-Status";
  }

  getTaskChallengeType(task: TaskView): string {
    const data = task.config.data ?? {};
    const value = data["liveChallengeType"] ?? data["captchaType"] ?? data["challengeType"];
    return value ? String(value) : "";
  }

  getTaskPaymentStatus(task: TaskView): string {
    if (this.isMonitorTask(task)) return "";
    const preparation = task.config.data?.["paymentPreparation"] as Record<string, unknown> | undefined;
    if (!preparation) return "Zahlungsart wird im Checkout erkannt, sobald sie sichtbar ist.";
    return String(preparation["note"] ?? "Zahlungsstatus aktualisiert.");
  }

  getTaskDetectedPaymentMethods(task: TaskView): string {
    const preparation = task.config.data?.["paymentPreparation"] as Record<string, unknown> | undefined;
    const methods = preparation?.["detectedMethods"];
    return Array.isArray(methods) && methods.length ? methods.join(", ") : "";
  }

  getCaptchaKeyStatusLabel(): string {
    return this.system.captchaApiKeyConfigured ? "API-Key gesetzt" : "API-Key fehlt";
  }

  getSupportedChallengeTypes(): string {
    return this.system.liveChallengeSupport?.length
      ? this.system.liveChallengeSupport.join(", ")
      : "turnstile, recaptcha, shopify-checkpoint";
  }

  getPlatformLabel(platform: CommercePlatform): string {
    const labels: Record<CommercePlatform, string> = {
      shopify: "Shopify",
      woocommerce: "WooCommerce",
      jtl: "JTL-Shop",
      wix: "Wix Stores",
      shopware: "Shopware",
      magento: "Magento / Adobe Commerce",
      bigcommerce: "BigCommerce",
      prestashop: "PrestaShop",
      squarespace: "Squarespace Commerce",
      ecwid: "Ecwid",
      lightspeed: "Lightspeed eCom",
      commercetools: "commercetools",
      "salesforce-commerce-cloud": "Salesforce Commerce Cloud",
      custom: "Custom / Sonstige"
    };
    return labels[platform] || platform;
  }

  getPaymentMethodLabel(method?: PaymentMethod): string {
    const labels: Record<PaymentMethod, string> = {
      card: "Karte",
      paypal: "PayPal",
      "shop-pay": "Shop Pay",
      klarna: "Klarna",
      other: "Andere"
    };
    return method ? labels[method] : "Nicht gesetzt";
  }

  hasExecutorForShop(shop: ShopView): boolean {
    return this.executorPlatforms.includes(shop.platform);
  }

  getSystemNodeStatusLabel(): string {
    if (this.system.browserPreview) return "Browser-Vorschau";
    if (!this.system.systemNode) return "Node unbekannt";
    return this.system.systemNode.ok ? "NODE OK" : "NODE FEHLER";
  }

  getSystemNodeDetails(): string {
    if (this.system.browserPreview) return "Echter Worker-Check läuft nur in Electron.";
    const node = this.system.systemNode;
    if (!node) return "System Node konnte nicht geprüft werden.";
    const version = node.version || "unbekannt";
    const requirement = this.system.systemNodeRequirement || ">=20";
    const base = `${node.executable} ${version} · benötigt ${requirement}`;
    return node.ok ? base : `${base} · ${node.error || "Worker kann evtl. nicht starten."}`;
  }

  getPersistenceStatusLabel(): string {
    if (this.system.browserPreview) return "PREVIEW";
    return this.system.persistence?.ready && !this.system.persistence?.error ? "SQLITE OK" : "DB FEHLER";
  }

  getPersistenceDetails(): string {
    if (this.system.browserPreview) return "Browser-Vorschau speichert nur im Arbeitsspeicher.";
    const persistence = this.system.persistence;
    if (!persistence) return "Persistenzstatus unbekannt.";
    return persistence.error || `${persistence.type.toUpperCase()} · Task-Historie aktiv`;
  }

  isSystemNodeOk(): boolean {
    return Boolean(this.system.browserPreview || this.system.systemNode?.ok);
  }

  isPersistenceOk(): boolean {
    return Boolean(this.system.browserPreview || (this.system.persistence?.ready && !this.system.persistence?.error));
  }

  isStartable(task: TaskView): boolean {
    return task.state === TaskState.QUEUED;
  }

  isPausable(task: TaskView): boolean {
    return [
      TaskState.QUEUED,
      TaskState.STARTING,
      TaskState.RUNNING,
      TaskState.WAITING_QUEUE,
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
      TaskState.WAITING_QUEUE,
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
