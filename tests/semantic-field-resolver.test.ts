import type { SemanticEmbeddingProvider } from "../src/browser-worker/field-semantic-resolver";
import { FieldSemanticResolver, type FieldDescriptor } from "../src/browser-worker/field-semantic-resolver";

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

class ConceptEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map(text => this.vector(text.toLowerCase()));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(14).fill(0.01);
    const concepts: Array<[RegExp, number]> = [
      [/mail|e-mail|kontaktkanal-x/, 0],
      [/given|first name|vorname|rufname/, 1],
      [/family|surname|nachname|familienname/, 2],
      [/complete person's name|full name|vollständiger name|empfängername/, 3],
      [/street name without|straße ohne|street-only-x/, 4],
      [/primary address|street and house|straße und hausnummer|anschrift/, 5],
      [/house number|hausnummer/, 6],
      [/secondary|apartment|adresszusatz|zusatz/, 7],
      [/city|town|locality|stadt|ort|gemeinde|zielort-x/, 8],
      [/postal|zip|postleitzahl|zustellcode|postgebiet/, 9],
      [/phone|mobile|telefon|mobil|rufnummer/, 10],
      [/country|land/, 11],
      [/shipping|delivery|lieferanschrift|versandadresse|shipbucket/, 12],
      [/billing|invoice|rechnungsanschrift|rechnungsadresse|billbucket/, 13]
    ];
    for (const [pattern, index] of concepts) {
      if (pattern.test(text)) vector[index] = 1;
    }
    return vector;
  }
}

describe("FieldSemanticResolver", () => {
  it("uses standards to resolve intent and context without embeddings", async () => {
    const provider = new ConceptEmbeddingProvider();
    const resolver = new FieldSemanticResolver(provider);

    const result = await resolver.resolve([
      field({ autocomplete: "shipping postal-code" }),
      field({ inputType: "email", autocomplete: "billing email" }),
      field({ autocomplete: "shipping given-name" })
    ]);

    expect(result.map(item => item.target)).toEqual([
      { intent: "postalCode", context: "shipping" },
      { intent: "email", context: "billing" },
      { intent: "firstName", context: "shipping" }
    ]);
    expect(result.every(item => item.source.intent === "standard-metadata")).toBe(true);
    expect(result.every(item => item.source.context === "standard-metadata")).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it("resolves German intent and address context as separate dimensions", async () => {
    const resolver = new FieldSemanticResolver(new ConceptEmbeddingProvider());

    const result = await resolver.resolve([
      field({ index: 0, label: "Vorname der Rechnungsanschrift" }),
      field({ index: 1, label: "Ort der Lieferanschrift" }),
      field({ index: 2, label: "Name des Empfängers" })
    ]);

    expect(result[0].target).toEqual({ intent: "firstName", context: "billing" });
    expect(result[1].target).toEqual({ intent: "city", context: "shipping" });
    expect(result[2].target).toEqual({ intent: "fullName", context: "shipping" });
  });

  it("enforces combined address field > standalone house-number pattern", async () => {
    const resolver = new FieldSemanticResolver(new ConceptEmbeddingProvider());

    const result = await resolver.resolve([
      field({ index: 0, label: "Straße und Hausnummer" }),
      field({ index: 1, label: "Straße / Hausnummer Rechnungsadresse" }),
      field({ index: 2, label: "Straße + Hausnummer Lieferanschrift" }),
      field({ index: 3, label: "Straße und Hausnummer Rechnungsadresse" }),
      field({ index: 4, label: "Hausnummer der Lieferanschrift" }),
      field({ index: 5, label: "Haus-Nr. Rechnungsadresse" }),
      field({ index: 6, label: "Hausnr. Lieferanschrift" })
    ]);

    expect(result[0].target.intent).toBe("address1");
    expect(result[1].target).toEqual({ intent: "address1", context: "billing" });
    expect(result[2].target).toEqual({ intent: "address1", context: "shipping" });
    expect(result[3].target).toEqual({ intent: "address1", context: "billing" });
    expect(result[4].target).toEqual({ intent: "houseNumber", context: "shipping" });
    expect(result[5].target).toEqual({ intent: "houseNumber", context: "billing" });
    expect(result[6].target).toEqual({ intent: "houseNumber", context: "shipping" });
  });

  it("keeps split street and house-number fields separate for shipping and billing", async () => {
    const resolver = new FieldSemanticResolver(new ConceptEmbeddingProvider());

    const result = await resolver.resolve([
      field({ index: 0, label: "Straße der Lieferanschrift" }),
      field({ index: 1, label: "Hausnummer der Lieferanschrift" }),
      field({ index: 2, label: "Straße der Rechnungsadresse" }),
      field({ index: 3, label: "Hausnummer der Rechnungsadresse" })
    ]);

    expect(result[0].target).toEqual({ intent: "street", context: "shipping" });
    expect(result[1].target).toEqual({ intent: "houseNumber", context: "shipping" });
    expect(result[2].target).toEqual({ intent: "street", context: "billing" });
    expect(result[3].target).toEqual({ intent: "houseNumber", context: "billing" });
  });

  it("treats bare Nr. as houseNumber only with strong field metadata", async () => {
    const resolver = new FieldSemanticResolver(new ConceptEmbeddingProvider());

    const result = await resolver.resolve([
      field({ index: 0, label: "Nr." }),
      field({ index: 1, label: "Nr.", name: "shipping_house_number", nearbyText: "Lieferanschrift" }),
      field({ index: 2, label: "Nr.", id: "billing-street-number", nearbyText: "Rechnungsadresse" })
    ]);

    expect(result[0].target.intent).toBe("unknown");
    expect(result[1].target).toEqual({ intent: "houseNumber", context: "shipping" });
    expect(result[2].target).toEqual({ intent: "houseNumber", context: "billing" });
  });

  it("does not guess firstName from a bare Name field", async () => {
    const resolver = new FieldSemanticResolver(new ConceptEmbeddingProvider());
    const result = await resolver.resolve([field({ label: "Name" })]);

    expect(result[0].target.intent).toBe("unknown");
  });

  it("can infer unresolved intent and context together in one embedding batch", async () => {
    const provider = new ConceptEmbeddingProvider();
    const resolver = new FieldSemanticResolver(provider);

    const result = await resolver.resolve([
      field({ index: 0, label: "shipbucket zielort-x" }),
      field({ index: 1, ariaLabel: "billbucket kontaktkanal-x" })
    ]);

    expect(result[0].target).toEqual({ intent: "city", context: "shipping" });
    expect(result[1].target).toEqual({ intent: "email", context: "billing" });
    expect(result.every(item => item.source.intent === "embedding")).toBe(true);
    expect(result.every(item => item.source.context === "embedding")).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it("reuses the full semantic decision for the same descriptor", async () => {
    const provider = new ConceptEmbeddingProvider();
    const resolver = new FieldSemanticResolver(provider);
    const descriptor = field({ label: "shipbucket zielort-x" });

    expect((await resolver.resolve([descriptor]))[0].target).toEqual({ intent: "city", context: "shipping" });
    expect((await resolver.resolve([descriptor]))[0].target).toEqual({ intent: "city", context: "shipping" });
    expect(provider.calls).toHaveLength(1);
  });
});