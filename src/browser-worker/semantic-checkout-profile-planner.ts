import type { Locator, Page } from "patchright";
import type { AresProfile } from "../profiles/models";
import type { UiInteractionHelper } from "./ui-interaction-helper";
import { SemanticProfileMapper } from "./semantic-profile-mapper";
import { semanticTarget } from "./semantic-target";

export interface SemanticCheckoutProfilePlan {
  values: SemanticProfileMapper;
  billingMode: "explicit-billing" | "same-as-shipping" | "separate-billing-fields";
}

const SAME_AS_SHIPPING_TEXT = /(?:same\s+as\s+(?:shipping|delivery)|billing\s+address\s+(?:is\s+)?same\s+as|rechnungs(?:adresse|anschrift)\s+(?:ist\s+)?(?:gleich|entspricht)\s+(?:der\s+)?liefer(?:adresse|anschrift)|liefer(?:adresse|anschrift)\s+(?:auch|als)\s+rechnungs(?:adresse|anschrift))/i;

export class SemanticCheckoutProfilePlanner {
  constructor(private readonly interactions: UiInteractionHelper) {}

  async prepare(page: Page, profile: AresProfile): Promise<SemanticCheckoutProfilePlan> {
    const preferred = new SemanticProfileMapper(profile, { billingMode: "prefer-same-as-shipping" });

    // A concrete billing address value means an explicit billing address exists and wins.
    if (preferred.valueFor(semanticTarget("city", "billing"))) {
      return { values: preferred, billingMode: "explicit-billing" };
    }

    if (await this.activateSameAsShipping(page)) {
      return { values: preferred, billingMode: "same-as-shipping" };
    }

    // No usable same-as-shipping control: billing remains a distinct target identity,
    // but its value source falls back centrally to shipping/default.
    return {
      values: new SemanticProfileMapper(profile, { billingMode: "separate-billing-fields" }),
      billingMode: "separate-billing-fields"
    };
  }

  private async activateSameAsShipping(page: Page): Promise<boolean> {
    const candidates = page.locator('label, button, [role="checkbox"], [role="radio"], input[type="checkbox"], input[type="radio"]');
    const count = Math.min(await candidates.count().catch(() => 0), 120);

    for (let index = 0; index < count; index++) {
      const candidate = candidates.nth(index);
      const text = await this.candidateText(candidate).catch(() => "");
      if (!SAME_AS_SHIPPING_TEXT.test(text)) continue;

      const control = await this.resolveControl(page, candidate);
      if (!control || !await control.isVisible({ timeout: 120 }).catch(() => false)) continue;
      if (await this.isSelected(control)) return true;

      await this.interactions.click(control, {
        attempts: 2,
        seed: "semantic-billing:same-as-shipping"
      }).catch(() => undefined);
      if (await this.isSelected(control)) return true;
    }

    return false;
  }

  private async candidateText(locator: Locator): Promise<string> {
    return locator.evaluate(element => {
      const input = element as HTMLInputElement;
      const id = input.id || "";
      const explicitLabel = id
        ? Array.from(document.querySelectorAll("label")).find(label => label.htmlFor === id)?.textContent || ""
        : "";
      const enclosingLabel = element.closest("label")?.textContent || "";
      return [
        element.textContent || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("name") || "",
        element.getAttribute("id") || "",
        explicitLabel,
        enclosingLabel
      ].join(" ").replace(/\s+/g, " ").trim();
    });
  }

  private async resolveControl(page: Page, candidate: Locator): Promise<Locator | undefined> {
    const tag = await candidate.evaluate(element => element.tagName.toLowerCase()).catch(() => "");
    const type = await candidate.getAttribute("type").catch(() => null);
    const role = await candidate.getAttribute("role").catch(() => null);

    if (tag === "input" && (type === "checkbox" || type === "radio")) return candidate;
    if (role === "checkbox" || role === "radio" || tag === "button") return candidate;

    if (tag === "label") {
      const forId = await candidate.getAttribute("for").catch(() => null);
      if (forId) {
        const escaped = forId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return page.locator(`[id="${escaped}"]`).first();
      }
      const nested = candidate.locator('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]').first();
      if (await nested.count().catch(() => 0)) return nested;
    }

    return undefined;
  }

  private async isSelected(control: Locator): Promise<boolean> {
    const checked = await control.isChecked().catch(() => false);
    if (checked) return true;
    return (await control.getAttribute("aria-checked").catch(() => null)) === "true";
  }
}
