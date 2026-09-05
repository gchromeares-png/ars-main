import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AresBrowserRuntime } from "../src/browser-worker/ares-browser-runtime";
import type { Page } from "../src/browser-worker/types";
import type {
  FieldDescriptor,
  ResolvedField,
  SemanticEmbeddingProvider
} from "../src/browser-worker/field-semantic-resolver";
import { FieldSemanticResolver } from "../src/browser-worker/field-semantic-resolver";
import { semanticTarget } from "../src/browser-worker/semantic-target";
import type { AresProfile } from "../src/profiles/models";
import { ShopifyTaskExecutor } from "../src/shopify/shopify-task-executor";

function field(overrides: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    index: 0,
    tagName: "input",
    inputType: "text",
    name: "",
    id: "",
    autocomplete: "",
    placeholder: "",
    ariaLabel: "",
    label: "",
    nearbyText: "",
    ...overrides
  };
}

class FailingEmbeddingProvider implements SemanticEmbeddingProvider {
  calls = 0;

  async embed(): Promise<number[][]> {
    this.calls += 1;
    throw new Error("local embedding runtime unavailable");
  }
}

class UnknownResolver {
  async resolve(fields: FieldDescriptor[]): Promise<ResolvedField[]> {
    return fields.map(descriptor => ({
      descriptor,
      target: semanticTarget("unknown", "unknown"),
      confidence: 0,
      intentConfidence: 0,
      contextConfidence: 0,
      source: { intent: "unknown", context: "unknown" }
    }));
  }
}

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

describe("resolver fallback handoff baseline", () => {
  it("preserves deterministic dimensions and leaves unresolved dimensions unknown when embeddings fail", async () => {
    const provider = new FailingEmbeddingProvider();
    const resolver = new FieldSemanticResolver(provider);

    const result = await resolver.resolve([
      field({ index: 0, inputType: "email", label: "Kontakt" }),
      field({ index: 1, label: "Kundenreferenz" })
    ]);

    expect(provider.calls).toBe(1);
    expect(result[0].target).toEqual({ intent: "email", context: "unknown" });
    expect(result[0].source.intent).toBe("standard-metadata");
    expect(result[0].source.context).toBe("unknown");
    expect(result[1].target).toEqual({ intent: "unknown", context: "unknown" });
    expect(result[1].source.intent).toBe("unknown");
    expect(result[1].source.context).toBe("unknown");
  });
});

describeBrowser("resolver -> Shopify deterministic fallback handoff", () => {
  jest.setTimeout(45_000);

  it("lets the deterministic Shopify fallback fill a known selector when semantic resolution stays unknown", async () => {
    const runtime = new AresBrowserRuntime();
    const taskId = `resolver-handoff-${Date.now()}`;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ares-resolver-handoff-"));
    try {
      const page: Page = (await runtime.createContext({ taskId, userDataDir, headless: true })).page;
      const html = `<!doctype html><html><body>
        <input data-decoy="true" value="">
        <input name="city" value="">
      </body></html>`;
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: "domcontentloaded" });

      const profile: AresProfile = {
        id: "resolver-handoff",
        name: "Resolver Handoff",
        contact: { firstName: "Test", lastName: "User", email: "test@example.invalid" },
        address: { address1: "Example 1", postalCode: "20095", city: "Hamburg", countryCode: "DE" },
        browser: { kiAutofill: true }
      };

      const executor = new ShopifyTaskExecutor(() => undefined);
      (executor as any).fieldResolver = new UnknownResolver();
      const result = await (executor as any).fillCheckoutProfile(page, profile);

      expect(await page.locator('input[name="city"]').inputValue()).toBe("Hamburg");
      expect(await page.locator('[data-decoy="true"]').inputValue()).toBe("");
      expect(result.filled).toEqual(expect.arrayContaining([
        expect.objectContaining({ intent: "city", context: "unknown" })
      ]));
      expect(result.requiredTargetsSatisfied).toBe(true);
      expect(result.trace?.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          intent: "city",
          context: "unknown",
          resolverSource: { intent: "fallback", context: "fallback" },
          valueAvailable: true,
          action: "fallback-write",
          result: "fallback-filled"
        })
      ]));
      expect(JSON.stringify(result.trace)).not.toContain("Hamburg");
    } finally {
      await runtime.closeContext(taskId).catch(() => undefined);
      await runtime.shutdown().catch(() => undefined);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
