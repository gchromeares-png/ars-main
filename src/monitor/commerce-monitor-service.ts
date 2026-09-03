import type { ITaskExecutor } from "../interfaces";
import type { Task } from "../models";
import type { CommerceShop } from "../commerce/platforms";
import type { CommerceProductApiRouter } from "../commerce/product-api/router";
import type {
  ProductCriteria,
  ProductMonitorEvent,
  ProductObservation
} from "./models";
import { ProductMatcher } from "./product-matcher";
import { ProductMonitor } from "./product-monitor";

export interface ProductMonitorEventRepository {
  recordProductMonitorEvent(taskId: string, event: ProductMonitorEvent): Promise<void>;
  findProductMonitorEventsByTaskId(taskId: string, limit?: number): Promise<Array<ProductMonitorEvent & { id?: number; taskId: string }>>;
}

export interface CommerceMonitorServiceOptions {
  defaultIntervalMs?: number;
  minimumIntervalMs?: number;
  searchLimit?: number;
  onEvent?: (taskId: string, event: ProductMonitorEvent) => void;
}

interface ActiveMonitorRun {
  controller: AbortController;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function getTaskProductCriteria(task: Task): ProductCriteria | undefined {
  const raw = asRecord(task.config.data?.["productCriteria"]);
  if (!raw) return undefined;

  const criteria: ProductCriteria = {};

  if (typeof raw["searchTerm"] === "string") criteria.searchTerm = raw["searchTerm"];
  if (typeof raw["sku"] === "string") criteria.sku = raw["sku"];
  if (typeof raw["gtin"] === "string") criteria.gtin = raw["gtin"];
  if (typeof raw["url"] === "string") criteria.url = raw["url"];
  if (typeof raw["requireAvailable"] === "boolean") criteria.requireAvailable = raw["requireAvailable"];
  if (typeof raw["minStock"] === "number") criteria.minStock = raw["minStock"];
  if (typeof raw["minPrice"] === "number") criteria.minPrice = raw["minPrice"];
  if (typeof raw["maxPrice"] === "number") criteria.maxPrice = raw["maxPrice"];
  if (typeof raw["minimumScore"] === "number") criteria.minimumScore = raw["minimumScore"];

  return criteria;
}

export function isCommerceMonitorTask(task: Task): boolean {
  return Boolean(asRecord(task.config.data?.["productCriteria"]));
}

function isRelevantChange(event: ProductMonitorEvent): boolean {
  return event.type !== "unchanged";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise(resolve => {
    const timer = setTimeout(done, ms);

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

export class CommerceMonitorService implements ITaskExecutor {
  private readonly matcher = new ProductMatcher();
  private readonly monitors = new Map<string, ProductMonitor>();
  private readonly activeRuns = new Map<string, ActiveMonitorRun>();
  private readonly defaultIntervalMs: number;
  private readonly minimumIntervalMs: number;
  private readonly searchLimit: number;

  constructor(
    private readonly getShop: (shopId: string) => CommerceShop | undefined,
    private readonly productApiRouter: Pick<CommerceProductApiRouter, "search">,
    private readonly repository: ProductMonitorEventRepository,
    private readonly options: CommerceMonitorServiceOptions = {}
  ) {
    this.defaultIntervalMs = Math.max(1, options.defaultIntervalMs ?? 30_000);
    this.minimumIntervalMs = Math.max(1, options.minimumIntervalMs ?? 1_000);
    this.searchLimit = Math.min(250, Math.max(1, options.searchLimit ?? 50));
  }

  async execute(task: Task): Promise<boolean> {
    const shopId = task.config.shopId;
    if (!shopId) {
      task.lastError = "Monitoring-Task hat keine shopId.";
      return false;
    }

    const shop = this.getShop(shopId);
    if (!shop) {
      task.lastError = `Shop ${shopId} ist nicht registriert.`;
      return false;
    }

    const criteria = getTaskProductCriteria(task);
    if (!criteria) {
      task.lastError = "Monitoring-Task hat keine productCriteria.";
      return false;
    }

    if (this.activeRuns.has(task.id)) {
      task.lastError = `Monitoring für Task ${task.id} läuft bereits.`;
      return false;
    }

    const controller = new AbortController();
    const run: ActiveMonitorRun = { controller };
    this.activeRuns.set(task.id, run);

    try {
      while (!controller.signal.aborted) {
        await this.runCycle(task, shop, criteria, controller.signal);
        if (controller.signal.aborted) break;
        await abortableDelay(this.intervalFor(task), controller.signal);
      }

      task.lastError = undefined;
      return true;
    } catch (error) {
      if (controller.signal.aborted) return true;
      task.lastError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (this.activeRuns.get(task.id) === run) {
        this.activeRuns.delete(task.id);
      }
    }
  }

  async runCycle(
    task: Task,
    shop?: CommerceShop,
    criteria?: ProductCriteria,
    signal?: AbortSignal
  ): Promise<ProductMonitorEvent[]> {
    const resolvedShopId = task.config.shopId;
    if (!resolvedShopId) throw new Error("Monitoring-Task hat keine shopId.");

    const resolvedShop = shop ?? this.getShop(resolvedShopId);
    if (!resolvedShop) throw new Error(`Shop ${resolvedShopId} ist nicht registriert.`);

    const resolvedCriteria = criteria ?? getTaskProductCriteria(task);
    if (!resolvedCriteria) throw new Error("Monitoring-Task hat keine productCriteria.");

    const observations = await this.productApiRouter.search(
      resolvedShop,
      resolvedCriteria,
      this.searchLimit
    );

    if (signal?.aborted) return [];

    const ranked = observations
      .map(observation => ({
        observation,
        match: this.matcher.match(observation, resolvedCriteria)
      }))
      .filter(candidate => candidate.match.matched)
      .sort((a, b) => b.match.score - a.match.score);

    const monitor = this.monitorFor(task.id);
    const relevantEvents: ProductMonitorEvent[] = [];

    for (const candidate of ranked) {
      if (signal?.aborted) break;

      const event = monitor.observe(candidate.observation, resolvedCriteria);
      if (!event || !isRelevantChange(event)) continue;

      await this.repository.recordProductMonitorEvent(task.id, event);
      relevantEvents.push(event);
      this.options.onEvent?.(task.id, event);
    }

    return relevantEvents;
  }

  async cancelTask(taskId: string): Promise<void> {
    this.activeRuns.get(taskId)?.controller.abort();
  }

  resetTask(taskId: string): void {
    this.monitors.delete(taskId);
  }

  async close(): Promise<void> {
    for (const run of this.activeRuns.values()) {
      run.controller.abort();
    }
    this.activeRuns.clear();
    this.monitors.clear();
  }

  private monitorFor(taskId: string): ProductMonitor {
    let monitor = this.monitors.get(taskId);
    if (!monitor) {
      monitor = new ProductMonitor(this.matcher);
      this.monitors.set(taskId, monitor);
    }
    return monitor;
  }

  private intervalFor(task: Task): number {
    const configured = Number(task.config.data?.["monitorIntervalMs"] ?? this.defaultIntervalMs);
    if (!Number.isFinite(configured)) return this.defaultIntervalMs;
    return Math.max(this.minimumIntervalMs, Math.floor(configured));
  }
}
