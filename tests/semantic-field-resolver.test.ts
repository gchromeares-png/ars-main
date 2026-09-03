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
    const vector = new Array<number>(9).fill(0.02);
    const concepts: Array<[RegExp, number]> = [
      [/mail|e-mail/, 0],
      [/given|first name|vorname|rufname/, 1],
      [/family|surname|nachname|familienname/, 2],
      [/street|straße|hausnummer|straßenanschrift/, 3],
      [/secondary|apartment|adresszusatz|zusatz/, 4],
      [/city|town|locality|stadt|ort|gemeinde|lieferort/, 5],
      [/postal|zip|postleitzahl|zustellcode|postgebiet/, 6],
      [/phone|mobile|telefon|mobil|rufnummer/, 7],
      [/country|land/, 8]
    ];
    for (const [pattern, index] of concepts) {
      if (pattern.test(text)) vector[index] = 1;
    }
    return vector;
  }
}

describe("FieldSemanticResolver", () => {
  it("uses standard browser metadata without waiting for an embedding model", async () => {
    const provider = new ConceptEmbeddingProvider();
    const resolver = new FieldSemanticResolver(provider);

    const result = await resolver.resolve([
      field({ autocomplete: "shipping postal-code" }),
      field({ inputType: "email" }),
      field({ autocomplete: "given-name" })
    ]);

    expect(result.map(item => item.intent)).toEqual(["postalCode", "email", "firstName"]);
    expect(result.every(item => item.source === "standard-metadata")).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it("classifies ambiguous German field text semantically in one embedding batch", async () => {
    const provider = new ConceptEmbeddingProvider();
    const resolver = new FieldSemanticResolver(provider);

    const result = await resolver.resolve([
      field({ index: 0, label: "Zustellcode für dein Paket" }),
      field({ index: 1, label: "Gemeinde der Lieferanschrift" }),
      field({ index: 2, ariaLabel: "Rufnummer für Rückfragen" })
    ]);

    expect(result.map(item => item.intent)).toEqual(["postalCode", "city", "phone"]);
    expect(result.every(item => item.source === "embedding")).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].length).toBeGreaterThan(3); // prototypes + all unresolved fields
  });

  it("reuses semantic decisions instead of embedding the same descriptor repeatedly", async () => {
    const provider = new ConceptEmbeddingProvider();
    const resolver = new FieldSemanticResolver(provider);
    const descriptor = field({ label: "Lieferort der Bestellung" });

    expect((await resolver.resolve([descriptor]))[0].intent).toBe("city");
    expect((await resolver.resolve([descriptor]))[0].intent).toBe("city");
    expect(provider.calls).toHaveLength(1);
  });
});
