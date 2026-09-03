import type { Locator, Page } from "patchright";
import type { UiInteractionHelper } from "./ui-interaction-helper";
import {
  collectFieldDescriptors,
  fieldLocator,
  type FieldSemanticResolver
} from "./field-semantic-resolver";
import {
  targetKey,
  type SemanticTarget,
  type SemanticTargetKey
} from "./semantic-target";
import type { SemanticFieldValueSource } from "./semantic-target-values";

export interface SemanticAutofillResult {
  filled: SemanticTarget[];
  missing: SemanticTarget[];
  writeCounts: Record<string, number>;
}

function normalizeValue(value: string): string {
  return value.trim();
}

export class SemanticFieldAutofill {
  private readonly completedTargets = new Map<SemanticTargetKey, Locator>();
  private readonly writeCounts = new Map<SemanticTargetKey, number>();
  private readonly seenTargets = new Map<SemanticTargetKey, SemanticTarget>();

  constructor(
    private readonly page: Page,
    private readonly interactions: UiInteractionHelper,
    private readonly resolver: FieldSemanticResolver
  ) {}

  async fillSemantic(values: SemanticFieldValueSource): Promise<void> {
    const descriptors = await collectFieldDescriptors(this.page);
    const resolved = await this.resolver.resolve(descriptors);
    const ranked = resolved
      .filter(item => item.target.intent !== "unknown")
      .sort((left, right) => right.confidence - left.confidence);

    for (const item of ranked) {
      if (item.target.intent === "unknown") continue;
      const value = values.valueFor(item.target);
      this.rememberTarget(item.target);
      if (!value?.trim()) continue;
      if (await this.isCompleted(item.target, value)) continue;

      const locator = fieldLocator(this.page, item.descriptor.index);
      if (!await locator.isVisible({ timeout: 120 }).catch(() => false)) continue;

      if (item.descriptor.tagName === "select") {
        await this.selectLocator(item.target, locator, value).catch(() => false);
      } else {
        await this.fillLocator(item.target, locator, value).catch(() => false);
      }
    }
  }

  async fillLocator(target: SemanticTarget, locator: Locator, value: string): Promise<boolean> {
    const desired = normalizeValue(value);
    if (!desired || target.intent === "unknown") return false;
    const key = this.rememberTarget(target);
    if (await this.isCompleted(target, desired)) return true;
    if (!await locator.isVisible({ timeout: 150 }).catch(() => false)) return false;

    const current = await this.readValue(locator);
    if (normalizeValue(current) === desired) {
      this.completedTargets.set(key, locator);
      return true;
    }

    await this.interactions.fill(locator, desired, {
      attempts: 2,
      seed: `semantic-fill:${key}`
    });
    this.bumpWriteCount(target);

    const after = await this.readValue(locator);
    if (normalizeValue(after) !== desired) return false;
    this.completedTargets.set(key, locator);
    return true;
  }

  async selectLocator(target: SemanticTarget, locator: Locator, value: string): Promise<boolean> {
    const desired = normalizeValue(value);
    if (!desired || target.intent === "unknown") return false;
    const key = this.rememberTarget(target);
    if (await this.isCompleted(target, desired)) return true;
    if (!await locator.isVisible({ timeout: 150 }).catch(() => false)) return false;

    const current = await this.readValue(locator);
    if (normalizeValue(current).toUpperCase() === desired.toUpperCase()) {
      this.completedTargets.set(key, locator);
      return true;
    }

    await this.interactions.select(locator, desired, {
      attempts: 2,
      seed: `semantic-select:${key}`
    });
    this.bumpWriteCount(target);

    const after = await this.readValue(locator);
    if (normalizeValue(after).toUpperCase() !== desired.toUpperCase()) return false;
    this.completedTargets.set(key, locator);
    return true;
  }

  async isComplete(target: SemanticTarget, value: string): Promise<boolean> {
    this.rememberTarget(target);
    return this.isCompleted(target, value);
  }

  async result(
    values: SemanticFieldValueSource,
    targets: SemanticTarget[] = [...this.seenTargets.values()]
  ): Promise<SemanticAutofillResult> {
    const filled: SemanticTarget[] = [];
    const missing: SemanticTarget[] = [];
    const uniqueTargets = new Map<SemanticTargetKey, SemanticTarget>();

    for (const target of targets) uniqueTargets.set(targetKey(target), target);

    for (const target of uniqueTargets.values()) {
      const value = values.valueFor(target);
      if (!value?.trim()) {
        missing.push({ ...target });
        continue;
      }
      if (await this.isCompleted(target, value)) filled.push({ ...target });
      else missing.push({ ...target });
    }

    const writeCounts: Record<string, number> = {};
    for (const [key, count] of this.writeCounts.entries()) writeCounts[key] = count;
    return { filled, missing, writeCounts };
  }

  private async isCompleted(target: SemanticTarget, value: string): Promise<boolean> {
    const key = targetKey(target);
    const locator = this.completedTargets.get(key);
    if (!locator) return false;
    const current = await this.readValue(locator);
    if (normalizeValue(current).toUpperCase() === normalizeValue(value).toUpperCase()) return true;
    this.completedTargets.delete(key);
    return false;
  }

  private rememberTarget(target: SemanticTarget): SemanticTargetKey {
    const key = targetKey(target);
    this.seenTargets.set(key, { ...target });
    return key;
  }

  private async readValue(locator: Locator): Promise<string> {
    return locator.inputValue({ timeout: 250 }).catch(() => "");
  }

  private bumpWriteCount(target: SemanticTarget): void {
    const key = targetKey(target);
    this.writeCounts.set(key, (this.writeCounts.get(key) ?? 0) + 1);
  }
}
