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

type Case = {
  name: string;
  descriptor: Partial<FieldDescriptor>;
  intent: string;
  context?: "shipping" | "billing" | "unknown";
};

const deterministicCases: Case[] = [
  { name: "email via autocomplete", descriptor: { autocomplete: "email" }, intent: "email" },
  { name: "email via input type", descriptor: { inputType: "email", name: "contact_value" }, intent: "email" },
  { name: "email via German label", descriptor: { label: "E-Mail-Adresse" }, intent: "email" },
  { name: "first name via autocomplete", descriptor: { autocomplete: "given-name" }, intent: "firstName" },
  { name: "first name via name", descriptor: { name: "first_name" }, intent: "firstName" },
  { name: "first name via id", descriptor: { id: "customer-given-name" }, intent: "firstName" },
  { name: "first name via placeholder", descriptor: { placeholder: "Ihr Vorname" }, intent: "firstName" },
  { name: "first name via aria", descriptor: { ariaLabel: "Vorname" }, intent: "firstName" },
  { name: "first name survives typo when name is strong", descriptor: { label: "Vornaem", name: "first_name" }, intent: "firstName" },
  { name: "last name via autocomplete", descriptor: { autocomplete: "family-name" }, intent: "lastName" },
  { name: "last name via German label", descriptor: { label: "Nachname" }, intent: "lastName" },
  { name: "full name via autocomplete", descriptor: { autocomplete: "name" }, intent: "fullName" },
  { name: "full name recipient label", descriptor: { label: "Name des Empfängers" }, intent: "fullName", context: "shipping" },
  { name: "phone via autocomplete", descriptor: { autocomplete: "tel" }, intent: "phone" },
  { name: "phone via input type", descriptor: { inputType: "tel", name: "contact" }, intent: "phone" },
  { name: "phone via German label", descriptor: { label: "Telefonnummer" }, intent: "phone" },
  { name: "postal code via autocomplete", descriptor: { autocomplete: "postal-code" }, intent: "postalCode" },
  { name: "postal code via PLZ", descriptor: { label: "PLZ" }, intent: "postalCode" },
  { name: "postal code via zip name", descriptor: { name: "zip_code" }, intent: "postalCode" },
  { name: "city via autocomplete", descriptor: { autocomplete: "address-level2" }, intent: "city" },
  { name: "city via Gemeinde", descriptor: { label: "Gemeinde" }, intent: "city" },
  { name: "country via autocomplete", descriptor: { autocomplete: "country" }, intent: "countryCode" },
  { name: "country via country-name", descriptor: { autocomplete: "country-name" }, intent: "countryCode" },
  { name: "country via German label", descriptor: { label: "Land" }, intent: "countryCode" },
  { name: "address1 via autocomplete", descriptor: { autocomplete: "address-line1" }, intent: "address1" },
  { name: "address1 combined und", descriptor: { label: "Straße und Hausnummer" }, intent: "address1" },
  { name: "address1 combined slash", descriptor: { label: "Straße / Hausnummer" }, intent: "address1" },
  { name: "address1 combined plus", descriptor: { label: "Straße + Hausnummer" }, intent: "address1" },
  { name: "address1 shipping context", descriptor: { label: "Straße und Hausnummer Lieferanschrift" }, intent: "address1", context: "shipping" },
  { name: "address1 billing context", descriptor: { label: "Straße und Hausnummer Rechnungsadresse" }, intent: "address1", context: "billing" },
  { name: "standalone house number", descriptor: { label: "Hausnummer" }, intent: "houseNumber" },
  { name: "standalone Haus-Nr", descriptor: { label: "Haus-Nr." }, intent: "houseNumber" },
  { name: "standalone Hausnr", descriptor: { label: "Hausnr." }, intent: "houseNumber" },
  { name: "house number shipping", descriptor: { label: "Hausnummer der Lieferanschrift" }, intent: "houseNumber", context: "shipping" },
  { name: "street only", descriptor: { label: "Straße" }, intent: "street" },
  { name: "street only English", descriptor: { label: "Street" }, intent: "street" },
  { name: "address2 via autocomplete", descriptor: { autocomplete: "address-line2" }, intent: "address2" },
  { name: "address2 via German label", descriptor: { label: "Adresszusatz" }, intent: "address2" },
  { name: "shipping postal code", descriptor: { autocomplete: "shipping postal-code" }, intent: "postalCode", context: "shipping" },
  { name: "billing postal code", descriptor: { autocomplete: "billing postal-code" }, intent: "postalCode", context: "billing" },
  { name: "shipping first name", descriptor: { autocomplete: "shipping given-name" }, intent: "firstName", context: "shipping" },
  { name: "billing last name", descriptor: { autocomplete: "billing family-name" }, intent: "lastName", context: "billing" }
];

describe("FieldSemanticResolver checkout fast-path guard", () => {
  it("resolves a broad checkout corpus deterministically with zero embeddings", async () => {
    const provider = new EmbeddingSpy();
    const resolver = new FieldSemanticResolver(provider);
    const fields = deterministicCases.map((testCase, index) => field({ index, ...testCase.descriptor }));

    const resolved = await resolver.resolve(fields);

    deterministicCases.forEach((testCase, index) => {
      expect(resolved[index]?.target.intent).toBe(testCase.intent);
      expect(resolved[index]?.target.context).toBe(testCase.context ?? "unknown");
      expect(resolved[index]?.source.intent).not.toBe("embedding");
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("does not depend on field order or contiguous checkout layout", async () => {
    const provider = new EmbeddingSpy();
    const resolver = new FieldSemanticResolver(provider);
    const mixed = [
      field({ index: 0, label: "PLZ" }),
      field({ index: 1, label: "Nachname" }),
      field({ index: 2, label: "Straße und Hausnummer" }),
      field({ index: 3, inputType: "email" }),
      field({ index: 4, label: "Gemeinde" }),
      field({ index: 5, autocomplete: "given-name" })
    ];

    const resolved = await resolver.resolve(mixed);

    expect(resolved.map(item => item.target.intent)).toEqual([
      "postalCode",
      "lastName",
      "address1",
      "email",
      "city",
      "firstName"
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps shipping and billing duplicates distinct", async () => {
    const provider = new EmbeddingSpy();
    const resolver = new FieldSemanticResolver(provider);
    const resolved = await resolver.resolve([
      field({ index: 0, autocomplete: "shipping given-name" }),
      field({ index: 1, autocomplete: "billing given-name" }),
      field({ index: 2, label: "Straße und Hausnummer Lieferanschrift" }),
      field({ index: 3, label: "Straße und Hausnummer Rechnungsadresse" }),
      field({ index: 4, autocomplete: "shipping postal-code" }),
      field({ index: 5, autocomplete: "billing postal-code" })
    ]);

    expect(resolved.map(item => item.target)).toEqual([
      { intent: "firstName", context: "shipping" },
      { intent: "firstName", context: "billing" },
      { intent: "address1", context: "shipping" },
      { intent: "address1", context: "billing" },
      { intent: "postalCode", context: "shipping" },
      { intent: "postalCode", context: "billing" }
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("never lets shipping or billing context create a field intent by itself", async () => {
    const resolver = new FieldSemanticResolver();
    const resolved = await resolver.resolve([
      field({ index: 0, autocomplete: "shipping" }),
      field({ index: 1, autocomplete: "billing" }),
      field({ index: 2, name: "shipping" }),
      field({ index: 3, id: "billing" }),
      field({ index: 4, label: "Shipping" }),
      field({ index: 5, nearbyText: "Rechnungsadresse" })
    ]);

    expect(resolved.map(item => item.target)).toEqual([
      { intent: "unknown", context: "shipping" },
      { intent: "unknown", context: "billing" },
      { intent: "unknown", context: "shipping" },
      { intent: "unknown", context: "billing" },
      { intent: "unknown", context: "shipping" },
      { intent: "unknown", context: "billing" }
    ]);
    expect(resolved.every(item => item.source.intent === "unknown")).toBe(true);
  });

  it("prefers strong metadata over noisy or misspelled labels", async () => {
    const provider = new EmbeddingSpy();
    const resolver = new FieldSemanticResolver(provider);
    const resolved = await resolver.resolve([
      field({ index: 0, label: "Vornaem", autocomplete: "given-name" }),
      field({ index: 1, label: "Famly nmae", autocomplete: "family-name" }),
      field({ index: 2, label: "Emaill", inputType: "email" }),
      field({ index: 3, label: "Postel cdoe", autocomplete: "postal-code" }),
      field({ index: 4, label: "Citty", autocomplete: "address-level2" })
    ]);

    expect(resolved.map(item => item.target.intent)).toEqual([
      "firstName",
      "lastName",
      "email",
      "postalCode",
      "city"
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("fails closed on genuinely ambiguous decoys when no provider is configured", async () => {
    const resolver = new FieldSemanticResolver();
    const resolved = await resolver.resolve([
      field({ index: 0, label: "Name" }),
      field({ index: 1, label: "Nr." }),
      field({ index: 2, label: "Referenz" }),
      field({ index: 3, name: "field_17", placeholder: "Bitte eingeben" }),
      field({ index: 4, ariaLabel: "Zusätzliche Angabe" })
    ]);

    expect(resolved.map(item => item.target.intent)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown"
    ]);
    expect(resolved.every(item => item.source.intent === "unknown")).toBe(true);
  });

  it("uses nearby text for address context without requiring embeddings", async () => {
    const provider = new EmbeddingSpy();
    const resolver = new FieldSemanticResolver(provider);
    const resolved = await resolver.resolve([
      field({ index: 0, label: "Vorname", nearbyText: "Lieferanschrift" }),
      field({ index: 1, label: "Nachname", nearbyText: "Rechnungsadresse" }),
      field({ index: 2, label: "PLZ", nearbyText: "Versandadresse" }),
      field({ index: 3, label: "Gemeinde", nearbyText: "Rechnungsanschrift" })
    ]);

    expect(resolved.map(item => item.target)).toEqual([
      { intent: "firstName", context: "shipping" },
      { intent: "lastName", context: "billing" },
      { intent: "postalCode", context: "shipping" },
      { intent: "city", context: "billing" }
    ]);
    expect(provider.calls).toHaveLength(0);
  });
});
