import type { Locator, Page } from "patchright";
import type { UiInteractionHelper } from "./ui-interaction-helper";
import {
  collectFieldDescriptors,
  fieldLocator,
  type FieldIntent,
  type FieldSemanticResolver
} from "./field-semantic-resolver";

export type FieldValueMap = Partial<Record<Exclude<FieldIntent, "unknown">, string>>;

export interface SemanticAutofillResult {
  filled: string[];
  missing: string[];
  writeCounts: Record<string, number>;
}

function normalizeValue(value: string): string {
  return value.trim();
}

export class SemanticFieldAutofill {
  private readonly completedTargets = new Map<Exclude<FieldIntent, "unknown">, Locator>();
  private readonly writeCounts = new Map<Exclude<FieldIntent, "unknown">, number>();

  constructor(
    private readonly page: Page,
    private readonly interactions: UiInteractionHelper,
    private readonly resolver: FieldSemanticResolver
  ) {}

  async fillSemantic(values: FieldValueMap): Promise<void> {
    const descriptors = await collectFieldDescriptors(this.page);
    const resolved = await this.resolver.resolve(descriptors);
    const ranked = resolved
      .filter(item => item.intent !== "unknown")
      .sort((left, right) => right.confidence - left.confidence);

    for (const item of ranked) {
      if (item.intent === "unknown") continue;
      const intent = item.intent as Exclude<FieldIntent, "unknown">;
      const value = values[intent];
      if (!value?.trim()) continue;
      if (await this.isCompleted(intent, value)) continue;

      const locator = fieldLocator(this.page, item.descriptor.index);
      if (!await locator.isVisible({ timeout: 120 }).catch(() => false)) continue;

      if (item.descriptor.tagName === "select") {
        await this.selectLocator(intent, locator, value).catch(() => false);
      } else {
        await this.fillLocator(intent, locator, value).catch(() => false);
      }
    }
  }

  async fillLocator(
    intent: Exclude<FieldIntent, "unknown">,
    locator: Locator,
    value: string
  ): Promise<boolean> {
    const desired = normalizeValue(value);
    if (!desired) return false;
    if (await this.isCompleted(intent, desired)) return true;
    if (!await locator.isVisible({ timeout: 150 }).catch(() => false)) return false;

    const current = await this.readValue(locator);
    if (normalizeValue(current) === desired) {
      this.completedTargets.set(intent, locator);
      return true;
    }

    await this.interactions.fill(locator, desired, {
      attempts: 2,
      seed: `semantic-fill:${intent}`
    });
    this.bumpWriteCount(intent);

    const after = await this.readValue(locator);
    if (normalizeValue(after) !== desired) return false;
    this.completedTargets.set(intent, locator);
    return true;
  }

  async selectLocator(
    intent: Exclude<FieldIntent, "unknown">,
    locator: Locator,
    value: string
  ): Promise<boolean> {
    const desired = normalizeValue(value);
    if (!desired) return false;
    if (await this.isCompleted(intent, desired)) return true;
    if (!await locator.isVisible({ timeout: 150 }).catch(() => false)) return false;

    const current = await this.readValue(locator);
    if (normalizeValue(current).toUpperCase() === desired.toUpperCase()) {
      this.completedTargets.set(intent, locator);
      return true;
    }

    await this.interactions.select(locator, desired, {
      attempts: 2,
      seed: `semantic-select:${intent}`
    });
    this.bumpWriteCount(intent);

    const after = await this.readValue(locator);
    if (normalizeValue(after).toUpperCase() !== desired.toUpperCase()) return false;
    this.completedTargets.set(intent, locator);
    return true;
  }

  async isComplete(intent: Exclude<FieldIntent, "unknown">, value: string): Promise<boolean> {
    return this.isCompleted(intent, value);
  }

  async result(targets: FieldValueMap): Promise<SemanticAutofillResult> {
    const filled: string[] = [];
    const missing: string[] = [];

    for (const rawIntent of Object.keys(targets) as Array<Exclude<FieldIntent, "unknown">>) {
      const value = targets[rawIntent];
      if (!value?.trim()) continue;
      if (await this.isCompleted(rawIntent, value)) filled.push(rawIntent);
      else missing.push(rawIntent);
    }

    const writeCounts: Record<string, number> = {};
    for (const [intent, count] of this.writeCounts.entries()) writeCounts[intent] = count;
    return { filled, missing, writeCounts };
  }

  private async isCompleted(intent: Exclude<FieldIntent, "unknown">, value: string): Promise<boolean> {
    const locator = this.completedTargets.get(intent);
    if (!locator) return false;
    const current = await this.readValue(locator);
    if (normalizeValue(current).toUpperCase() === normalizeValue(value).toUpperCase()) return true;
    this.completedTargets.delete(intent);
    return false;
  }

  private async readValue(locator: Locator): Promise<string> {
    return locator.inputValue({ timeout: 250 }).catch(() => "");
  }

  private bumpWriteCount(intent: Exclude<FieldIntent, "unknown">): void {
    this.writeCounts.set(intent, (this.writeCounts.get(intent) ?? 0) + 1);
  }
}
