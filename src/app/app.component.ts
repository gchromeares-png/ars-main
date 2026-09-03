import { Component, OnDestroy, OnInit } from "@angular/core";
import { ElectronService } from "./services/electron.service";
import { TaskState } from "../models";
import { COMMERCE_PLATFORMS, CommercePlatform } from "../commerce/platforms";
import type { CheckoutPaymentSession, PaymentMethod } from "../payments/models";
import type { AresProxy, ProxyProtocol, ProxySelection } from "../proxies/models";

type AppTab = "dashboard" | "tasks" | "profiles" | "proxies" | "shops";
type ProfileTab = "identity" | "address" | "browser" | "payment";
type TaskCreationMode = "monitor-only" | "auto-checkout";

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
    protocol?: ProxyProtocol;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };
  preferredProxyId?: string;
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
  profileCount?: number;
  proxyCount?: number;
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
  proxies: AresProxy[] = [];
  selectedProfileId = "";
  selectedShopId = "";
  commercePlatforms: CommercePlatform[] = [...COMMERCE_PLATFORMS];
  executorPlatforms: CommercePlatform[] = ["shopify"];

  newProfile: ProfileView = this.emptyProfile();
  newProxy: AresProxy = this.emptyProxy();
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
    profileCount: 0,
    proxyCount: 0,
    commercePlatforms: [...COMMERCE_PLATFORMS],
    commerceExecutorPlatforms: ["shopify"],
    commerceMonitorReady: true,
    captchaProvider: "CapMonster",
    captchaApiKeyConfigured: false,
    liveChallengeSupport: [],
    systemNode: { executable: "node", ok: false }
  };

  taskMode: TaskCreationMode = "monitor-only";
  taskName = "";
  searchTerm = "";
  taskIntervalSeconds = 30;
  headless = false;
  taskProxyMode: ProxySelection["mode"] = "profile-default";
  selectedTaskProxyId = "";

  taskPaymentEnabled = false;
  taskPaymentMethod: PaymentMethod = "card";
  taskPaymentLabel = "";
  sessionCardHolderName = "";
  sessionCardNumber = "";
  sessionCardExpiry = "";
  sessionCardSecurityCode = "";

  testingAllProxies = false;
  readonly testingProxyIds = new Set<string>();

  error = "";
  info = "";

  private unsubscribeStatus?: () => void;

  constructor(private readonly electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.loadShops(),
      this.loadProfiles(),
      this.loadProxies(),
      this.loadTasks(),
      this.loadSystemStatus()
    ]);

    this.syncProfileDefaults();
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

  get monitorOnlyTasks(): TaskView[] {
    return this.tasks.filter(task => this.isMonitorOnlyTask(task));
  }

  get autoCheckoutTasks(): TaskView[] {
    return this.tasks.filter(task => this.isAutoCheckoutTask(task));
  }

  get checkoutRuns(): TaskView[] {
    return this.tasks.filter(task => this.isCheckoutChildTask(task));
  }

  get activeTaskCount(): number {
    return this.tasks.filter(task => ![TaskState.SUCCESS, TaskState.FAILED, TaskState.CANCELLED].includes(task.state)).length;
  }

  get selectedShopSupportsCheckout(): boolean {
    const shop = this.shops.find(item => item.id === this.selectedShopId);
    return Boolean(shop && this.hasExecutorForShop(shop));
  }

  async loadProfiles(): Promise<void> {
    const result = await this.electron.getProfiles();
    if (!result.success) return;
    this.profiles = result.profiles;
    if (!this.selectedProfileId && this.profiles.length > 0) this.selectedProfileId = this.profiles[0].id;
  }

  async loadProxies(): Promise<void> {
    const result = await this.electron.getProxies();
    if (!result.success) return;
    this.proxies = result.proxies;
    if (this.selectedTaskProxyId && !this.proxies.some(proxy => proxy.id === this.selectedTaskProxyId)) {
      this.selectedTaskProxyId = "";
      if (this.taskProxyMode === "proxy") this.taskProxyMode = "profile-default";
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

    if (profile.preferredProxyId && !this.proxies.some(proxy => proxy.id === profile.preferredProxyId)) {
      this.error = "Der ausgewählte Standard-Proxy existiert nicht mehr.";
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
      preferredProxyId: profile.preferredProxyId || undefined,
      paymentPreference: {
        method: profile.paymentPreference?.method || "card",
        label: profile.paymentPreference?.label?.trim() || undefined
      }
    });

    if (!result.success) {
      this.error = result.error;
      return;
    }

    this.info = "Profil gespeichert.";
    await this.loadProfiles();
  }

  editProfile(profile: ProfileView): void {
    this.newProfile = {
      ...profile,
      contact: { ...profile.contact },
      address: { ...profile.address },
      proxy: profile.proxy ? { ...profile.proxy } : undefined,
      browser: { ...(profile.browser ?? {}) },
      paymentPreference: { ...(profile.paymentPreference ?? { method: "card" }) }
    };
    this.profileTab = "identity";
    this.info = `Profil ${profile.name} geladen.`;
  }

  resetProfileForm(): void {
    this.newProfile = this.emptyProfile();
    this.profileTab = "identity";
  }

  async saveProxy(): Promise<void> {
    this.error = "";
    this.info = "";
    const proxy = this.newProxy;
    if (!proxy.id.trim() || !proxy.name.trim() || !proxy.host.trim()) {
      this.error = "Proxy-ID, Name und Host sind erforderlich.";
      return;
    }
    const port = Number(proxy.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.error = "Proxy-Port muss zwischen 1 und 65535 liegen.";
      return;
    }

    const result = await this.electron.saveProxy({
      ...proxy,
      id: proxy.id.trim(),
      name: proxy.name.trim(),
      host: proxy.host.trim(),
      port,
      username: proxy.username?.trim() || undefined,
      password: proxy.password || undefined
    });
    if (!result.success) {
      this.error = result.error;
      return;
    }
    this.info = `Proxy ${result.proxy?.name || proxy.name} gespeichert.`;
    this.newProxy = this.emptyProxy();
    await Promise.all([this.loadProxies(), this.loadSystemStatus()]);
  }

  async testProxy(proxy: AresProxy): Promise<void> {
    if (this.testingProxyIds.has(proxy.id) || this.testingAllProxies) return;
    this.error = "";
    this.info = "";
    this.testingProxyIds.add(proxy.id);
    try {
      const result = await this.electron.testProxy(proxy.id);
      await this.loadProxies();
      if (!result.success) {
        this.error = result.error || `Proxy ${proxy.name} ist nicht erreichbar.`;
        return;
      }
      const latency = result.health?.latencyMs;
      this.info = `${proxy.name}: online${typeof latency === "number" ? ` · ${latency} ms` : ""}.`;
    } finally {
      this.testingProxyIds.delete(proxy.id);
    }
  }

  async testAllProxies(): Promise<void> {
    if (this.testingAllProxies || !this.proxies.length) return;
    this.error = "";
    this.info = "";
    this.testingAllProxies = true;
    try {
      const result = await this.electron.testAllProxies();
      await this.loadProxies();
      if (!result.success) {
        this.error = result.error || "Proxy-Checks konnten nicht abgeschlossen werden.";
        return;
      }
      const online = Array.isArray(result.results) ? result.results.filter((item: any) => item.success).length : 0;
      this.info = `Proxy-Checks abgeschlossen · ${online}/${this.proxies.length} online.`;
    } finally {
      this.testingAllProxies = false;
    }
  }

  isProxyTesting(proxyId: string): boolean {
    return this.testingAllProxies || this.testingProxyIds.has(proxyId);
  }

  getProxyLocation(proxy: AresProxy): string {
    const geo = proxy.health?.geo;
    if (!geo) return "Ort unbekannt";
    return [geo.city, geo.region, geo.countryCode || geo.country].filter(Boolean).join(" · ") || "Ort unbekannt";
  }

  getProxyNetwork(proxy: AresProxy): string {
    const geo = proxy.health?.geo;
    if (!geo) return "ASN / Provider unbekannt";
    return [geo.asn, geo.provider].filter(Boolean).join(" · ") || "ASN / Provider unbekannt";
  }

  getProxyRiskLabel(proxy: AresProxy): string {
    const reputation = proxy.health?.reputation;
    if (!reputation?.available) return "RISK —";
    return typeof reputation.riskScore === "number" ? `RISK ${reputation.riskScore}/100` : "RISK —";
  }

  getProxySpamLabel(proxy: AresProxy): string {
    const reputation = proxy.health?.reputation;
    if (!reputation?.available) return "SPAM —";
    return typeof reputation.spamHits === "number" ? `SPAM ${reputation.spamHits}` : "SPAM —";
  }

  getProxyCheckLabel(proxy: AresProxy): string {
    const health = proxy.health;
    if (!health) return "Noch nicht getestet";
    const time = new Date(health.checkedAt);
    const formatted = Number.isNaN(time.getTime()) ? health.checkedAt : time.toLocaleString("de-DE");
    return `Letzter Check ${formatted}`;
  }

  editProxy(proxy: AresProxy): void {
    this.newProxy = { ...proxy };
    this.info = `Proxy ${proxy.name} geladen.`;
  }

  async deleteProxy(proxyId: string): Promise<void> {
    this.error = "";
    this.info = "";
    const result = await this.electron.deleteProxy(proxyId);
    if (!result.success) {
      this.error = result.error || "Proxy konnte nicht gelöscht werden.";
      return;
    }
    if (this.newProxy.id === proxyId) this.newProxy = this.emptyProxy();
    this.info = "Proxy gelöscht.";
    await Promise.all([this.loadProxies(), this.loadSystemStatus()]);
  }

  async loadShops(): Promise<void> {
    const result = await this.electron.getShops();
    if (!result.success) return;
    this.shops = result.shops;
    if (Array.isArray(result.platforms) && result.platforms.length) this.commercePlatforms = result.platforms;
    if (Array.isArray(result.executorPlatforms)) this.executorPlatforms = result.executorPlatforms;
    if (!this.selectedShopId && this.shops.length > 0) this.selectedShopId = this.shops[0].id;
  }

  async loadTasks(): Promise<void> {
    const result = await this.electron.getTaskList();
    if (result.success) this.tasks = result.tasks;
  }

  async loadTaskLogs(taskId: string): Promise<void> {
    const result = await this.electron.getTaskLogs(taskId, 100);
    if (result.success) this.taskLogs[taskId] = result.logs;
    else this.error = result.error || "Task-Verlauf konnte nicht geladen werden.";
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
    if (!result.success) return;
    this.system = result;
    if (Array.isArray(result.commercePlatforms) && result.commercePlatforms.length) this.commercePlatforms = result.commercePlatforms;
    if (Array.isArray(result.commerceExecutorPlatforms)) this.executorPlatforms = result.commerceExecutorPlatforms;
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
      ? `${this.getPlatformLabel(platform)} Shop registriert · Monitoring + Checkout-Executor bereit.`
      : `${this.getPlatformLabel(platform)} Shop registriert · Monitoring verfügbar, Auto-Checkout benötigt einen Browser-Executor.`;
    this.newShop = { id: "", name: "", baseUrl: "", platform };
    await Promise.all([this.loadShops(), this.loadSystemStatus()]);
  }

  async createTask(): Promise<void> {
    this.error = "";
    this.info = "";

    if (!this.taskName.trim() || !this.selectedShopId || !this.searchTerm.trim()) {
      this.error = "Task-Name, Shop und Produkt/Keyword sind erforderlich.";
      return;
    }

    if (this.taskMode === "auto-checkout") {
      if (!this.selectedProfileId) {
        this.error = "Für Auto-Checkout ist ein Profil erforderlich.";
        return;
      }
      if (!this.selectedShopSupportsCheckout) {
        this.error = "Für diesen Shop ist kein Browser-Checkout-Executor verfügbar.";
        return;
      }
      if (this.taskProxyMode === "proxy" && !this.selectedTaskProxyId) {
        this.error = "Bitte einen Proxy für die Checkout-Session auswählen.";
        return;
      }
    }

    const taskId = `${this.taskMode === "auto-checkout" ? "auto" : "monitor"}_${Date.now()}`;
    const intervalSeconds = Math.max(1, Math.floor(Number(this.taskIntervalSeconds) || 30));
    const proxySelection: ProxySelection = {
      mode: this.taskProxyMode,
      ...(this.taskProxyMode === "proxy" ? { proxyId: this.selectedTaskProxyId } : {})
    };

    const monitorAction = this.taskMode === "auto-checkout"
      ? {
          mode: "auto-checkout",
          profileId: this.selectedProfileId,
          proxySelection,
          headless: this.headless,
          paymentEnabled: this.taskPaymentEnabled
        }
      : { mode: "monitor-only" };

    const result = await this.electron.createTask({
      id: taskId,
      name: this.taskName.trim(),
      shopId: this.selectedShopId,
      data: {
        productCriteria: { searchTerm: this.searchTerm.trim() },
        monitorIntervalMs: intervalSeconds * 1_000,
        monitorAction
      }
    });

    if (!result.success) {
      this.error = result.error;
      return;
    }

    if (this.taskMode === "auto-checkout" && this.taskPaymentEnabled) {
      const paymentResult = await this.electron.setPaymentSession(taskId, this.buildPaymentSession());
      if (!paymentResult.success) {
        this.error = `Task erstellt, aber Zahlungs-Session konnte nicht gesetzt werden: ${paymentResult.error}`;
        return;
      }
    }

    this.info = this.taskMode === "auto-checkout"
      ? `Auto-Checkout-Task ${result.taskId} erstellt. Bei Verfügbarkeit startet ARES genau eine isolierte Checkout-Session.`
      : `Monitoring-Task ${result.taskId} erstellt.`;
    this.taskName = "";
    this.searchTerm = "";
    this.clearSensitivePaymentInputs();
    await Promise.all([this.loadTasks(), this.loadSystemStatus()]);
  }

  syncProfileDefaults(): void {
    const profile = this.profiles.find(item => item.id === this.selectedProfileId);
    if (!profile) return;
    if (profile.paymentPreference?.method) {
      this.taskPaymentMethod = profile.paymentPreference.method;
      this.taskPaymentLabel = profile.paymentPreference.label || "";
    }
    this.taskProxyMode = "profile-default";
    this.selectedTaskProxyId = "";
  }

  async startTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.startTask(taskId);
    if (!result.success) this.error = result.error;
    await this.refreshTaskView(taskId);
  }

  async pauseTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.pauseTask(taskId);
    if (!result.success) this.error = result.error;
    await this.refreshTaskView(taskId);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.error = "";
    const result = await this.electron.resumeTask(taskId);
    if (!result.success) this.error = result.error;
    await this.refreshTaskView(taskId);
  }

  async stopTask(taskId: string): Promise<void> {
    this.error = "";
    await this.electron.clearPaymentSession(taskId);
    const result = await this.electron.stopTask(taskId);
    if (!result.success) this.error = result.error;
    await this.refreshTaskView(taskId);
  }

  isMonitorTask(task: TaskView): boolean {
    const criteria = task.config.data?.["productCriteria"];
    return Boolean(criteria && typeof criteria === "object");
  }

  isAutoCheckoutTask(task: TaskView): boolean {
    const action = task.config.data?.["monitorAction"] as Record<string, unknown> | undefined;
    return this.isMonitorTask(task) && action?.["mode"] === "auto-checkout";
  }

  isMonitorOnlyTask(task: TaskView): boolean {
    return this.isMonitorTask(task) && !this.isAutoCheckoutTask(task);
  }

  isCheckoutChildTask(task: TaskView): boolean {
    const trigger = task.config.data?.["triggerSource"] as Record<string, unknown> | undefined;
    return Boolean(trigger?.["parentTaskId"]);
  }

  getTaskKind(task: TaskView): string {
    if (this.isAutoCheckoutTask(task)) return "AUTO CHECKOUT";
    if (this.isMonitorOnlyTask(task)) return "MONITOR";
    if (this.isCheckoutChildTask(task)) return "CHECKOUT RUN";
    return "BROWSER";
  }

  getTaskProfileName(task: TaskView): string {
    let profileId = "";
    if (this.isAutoCheckoutTask(task)) {
      const action = task.config.data?.["monitorAction"] as Record<string, unknown> | undefined;
      profileId = String(action?.["profileId"] ?? "");
    } else if (!this.isMonitorTask(task)) {
      profileId = String(task.config.data?.["profileId"] ?? "");
    }
    if (!profileId) return this.isMonitorOnlyTask(task) ? "nicht benötigt" : "kein Profil";
    return this.profiles.find(profile => profile.id === profileId)?.name ?? profileId;
  }

  getTaskProxyStatus(task: TaskView): string {
    if (this.isMonitorOnlyTask(task)) return "nicht benötigt";

    if (this.isAutoCheckoutTask(task)) {
      const action = task.config.data?.["monitorAction"] as Record<string, unknown> | undefined;
      const selection = action?.["proxySelection"] as ProxySelection | undefined;
      const profileId = String(action?.["profileId"] ?? "");
      return this.proxySelectionLabel(selection, profileId);
    }

    const runtime = task.config.data?.["proxyRuntime"] as Record<string, unknown> | undefined;
    if (runtime?.["mode"] === "direct") return "Direktverbindung";
    if (runtime?.["proxyName"]) return String(runtime["proxyName"]);
    if (runtime?.["mode"] === "legacy-profile") return "Legacy Profil-Proxy";

    const selection = task.config.data?.["proxySelection"] as ProxySelection | undefined;
    const profileId = String(task.config.data?.["profileId"] ?? "");
    return this.proxySelectionLabel(selection, profileId);
  }

  getTaskAutomationStatus(task: TaskView): string {
    if (!this.isAutoCheckoutTask(task)) return "";
    const runtime = task.config.data?.["autoCheckoutRuntime"] as Record<string, unknown> | undefined;
    if (!runtime) return "Wartet auf verfügbares Produkt";
    if (runtime["status"] === "failed") return `Trigger fehlgeschlagen: ${String(runtime["error"] ?? "unbekannt")}`;
    if (runtime["childTaskId"]) return `Checkout gestartet · ${String(runtime["childTaskId"])}`;
    return "Checkout wird gestartet";
  }

  getTaskParentId(task: TaskView): string {
    const trigger = task.config.data?.["triggerSource"] as Record<string, unknown> | undefined;
    return trigger?.["parentTaskId"] ? String(trigger["parentTaskId"]) : "";
  }

  getTaskCaptchaStatus(task: TaskView): string {
    if (this.isMonitorTask(task)) return "Browser startet erst beim Checkout-Trigger";
    const data = task.config.data ?? {};
    const value = data["liveChallengeStatus"] ?? data["captchaStatus"] ?? data["challengeStatus"];
    return value ? String(value) : "Kein aktueller Challenge-Status";
  }

  getTaskChallengeType(task: TaskView): string {
    const data = task.config.data ?? {};
    const value = data["liveChallengeType"] ?? data["captchaType"] ?? data["challengeType"];
    return value ? String(value) : "";
  }

  getTaskPaymentStatus(task: TaskView): string {
    if (this.isMonitorOnlyTask(task)) return "";
    if (this.isAutoCheckoutTask(task)) {
      const action = task.config.data?.["monitorAction"] as Record<string, unknown> | undefined;
      return action?.["paymentEnabled"] ? "Session-Payment wird beim Treffer an den Checkout-Run übergeben." : "Payment bleibt manuell.";
    }
    const preparation = task.config.data?.["paymentPreparation"] as Record<string, unknown> | undefined;
    if (!preparation) return "Wird im Checkout erkannt, sobald sichtbar.";
    return String(preparation["note"] ?? "Zahlungsstatus aktualisiert.");
  }

  getTaskDetectedPaymentMethods(task: TaskView): string {
    const preparation = task.config.data?.["paymentPreparation"] as Record<string, unknown> | undefined;
    const methods = preparation?.["detectedMethods"];
    return Array.isArray(methods) && methods.length ? methods.join(", ") : "";
  }

  getProfileProxyName(profile: ProfileView): string {
    if (profile.preferredProxyId) return this.getProxyName(profile.preferredProxyId);
    if (profile.proxy?.host) return "Legacy Proxy";
    return "Direkt";
  }

  getProxyName(proxyId: string): string {
    return this.proxies.find(proxy => proxy.id === proxyId)?.name ?? proxyId;
  }

  getProxyEndpoint(proxy: AresProxy): string {
    return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
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
      shopify: "Shopify", woocommerce: "WooCommerce", jtl: "JTL-Shop", wix: "Wix Stores",
      shopware: "Shopware", magento: "Magento / Adobe Commerce", bigcommerce: "BigCommerce",
      prestashop: "PrestaShop", squarespace: "Squarespace Commerce", ecwid: "Ecwid",
      lightspeed: "Lightspeed eCom", commercetools: "commercetools",
      "salesforce-commerce-cloud": "Salesforce Commerce Cloud", custom: "Custom / Sonstige"
    };
    return labels[platform] || platform;
  }

  getPaymentMethodLabel(method?: PaymentMethod): string {
    const labels: Record<PaymentMethod, string> = {
      card: "Karte", paypal: "PayPal", "shop-pay": "Shop Pay", klarna: "Klarna", other: "Andere"
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
    return [TaskState.QUEUED, TaskState.STARTING, TaskState.RUNNING, TaskState.WAITING_QUEUE,
      TaskState.PRODUCT_FOUND, TaskState.CART, TaskState.CHECKOUT, TaskState.RETRYING].includes(task.state);
  }

  isResumable(task: TaskView): boolean {
    return task.state === TaskState.PAUSED;
  }

  isStoppable(task: TaskView): boolean {
    return [TaskState.STARTING, TaskState.RUNNING, TaskState.WAITING_QUEUE, TaskState.PRODUCT_FOUND,
      TaskState.CART, TaskState.CHECKOUT, TaskState.RETRYING, TaskState.PAUSED].includes(task.state);
  }

  trackTask(_index: number, task: TaskView): string { return task.id; }
  trackShop(_index: number, shop: ShopView): string { return shop.id; }
  trackProxy(_index: number, proxy: AresProxy): string { return proxy.id; }

  private proxySelectionLabel(selection: ProxySelection | undefined, profileId: string): string {
    if (selection?.mode === "direct") return "Direktverbindung";
    if (selection?.mode === "proxy" && selection.proxyId) return this.getProxyName(selection.proxyId);
    const profile = this.profiles.find(item => item.id === profileId);
    return profile?.preferredProxyId ? `Profilstandard · ${this.getProxyName(profile.preferredProxyId)}` : "Profilstandard · direkt";
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

  private async refreshTaskView(taskId: string): Promise<void> {
    await Promise.all([
      this.loadTasks(),
      this.loadSystemStatus(),
      this.expandedTaskLogId === taskId ? this.loadTaskLogs(taskId) : Promise.resolve()
    ]);
  }

  private emptyProfile(): ProfileView {
    return {
      id: "",
      name: "",
      contact: { firstName: "", lastName: "", email: "", phone: "" },
      address: { address1: "", address2: "", postalCode: "", city: "", countryCode: "DE" },
      preferredProxyId: "",
      browser: { headless: false, userAgent: "" },
      paymentPreference: { method: "card", label: "" }
    };
  }

  private emptyProxy(): AresProxy {
    return { id: "", name: "", protocol: "http", host: "", port: 8080, username: "", password: "" };
  }
}
