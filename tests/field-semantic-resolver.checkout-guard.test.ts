import {
  FieldSemanticResolver,
  type FieldDescriptor,
  type SemanticEmbeddingProvider
} from "../src/browser-worker/field-semantic-resolver";

function field(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
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

class EmbeddingSpy implements SemanticEmbeddingProvider {
  calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    throw new Error("Checkout fast-path guard: embedding fallback was invoked.");
  }
}

describe("FieldSemanticResolver checkout fast-path guard", () => {
  it("resolves standard checkout metadata without invoking embeddings", async () => {
    const provider = new EmbeddingSpy();
    const resolver = new FieldSemanticResolver(provider);
    const fields = [
      field({ index: 0, inputType: "email", autocomplete: "email", name: "email" }),
      field({ index: 1, autocomplete: "given-name", name: "first_name" }),
      field({ index: 2, autocomplete: "family-name", name: "last_name" }),
      field({ index: 3, autocomplete: "name", name: "recipient_name" }),
      field({ index: 4, inputType: "tel", autocomplete: "tel", name: "phone" }),
      field({ index: 5, autocomplete: "postal-code", name: "zip" }),
      field({ index: 6, autocomplete: "address-line1", name: "address1" }),
      field({ index: 7, autocomplete: "address-level2", name: "city" }),
      field({ index: 8, autocomplete: "country", name: "country" })
    ];

    const resolved = await resolver.resolve(fields);

    expect(resolved.map(item => item.target.intent)).toEqual([
      "email",
      "firstName",
      "lastName",
      "fullName",
      "phone",
      "postalCode",
      "address1",
      "city",
      "countryCode"
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps explicit shipping and billing metadata on the deterministic path", async () => {
    const provider = new EmbeddingSpy();
    const resolver = new FieldSemanticResolver(provider);
    const resolved = await resolver.resolve([
      field({ index: 0, autocomplete: "shipping address-line1", label: "Shipping address" }),
      field({ index: 1, autocomplete: "billing postal-code", label: "Billing ZIP" })
    ]);

    expect(resolved[0]?.target).toEqual({ intent: "address1", context: "shipping" });
    expect(resolved[1]?.target).toEqual({ intent: "postalCode", context: "billing" });
    expect(provider.calls).toHaveLength(0);
  });

  it("protects combined street-and-number semantics from generic house-number matching", async () => {
    const provider = new EmbeddingSpy();
    const resolver = new FieldSemanticResolver(provider);
    const resolved = await resolver.resolve([
      field({ index: 0, label: "Straße und Hausnummer", nearbyText: "Lieferanschrift" }),
      field({ index: 1, label: "Straße / Hausnummer", nearbyText: "Rechnungsadresse" }),
      field({ index: 2, label: "Hausnummer", autocomplete: "shipping" })
    ]);

    expect(resolved[0]?.target).toEqual({ intent: "address1", context: "shipping" });
    expect(resolved[1]?.target).toEqual({ intent: "address1", context: "billing" });
    expect(resolved[2]?.target).toEqual({ intent: "houseNumber", context: "shipping" });
    expect(provider.calls).toHaveLength(0);
  });
});
