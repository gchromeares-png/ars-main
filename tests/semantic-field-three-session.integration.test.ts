import * as http from "http";
import type { AddressInfo } from "net";
import { chromium } from "patchright";
import type { SemanticEmbeddingProvider } from "../src/browser-worker/field-semantic-resolver";
import { FieldSemanticResolver } from "../src/browser-worker/field-semantic-resolver";
import { SemanticFieldAutofill, type FieldValueMap } from "../src/browser-worker/semantic-field-autofill";
import { GhostCursorUiInteractionHelper } from "../src/browser-worker/ui-interaction-helper";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

class IntegrationEmbeddingProvider implements SemanticEmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.vector(text.toLowerCase()));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(9).fill(0.01);
    const concepts: Array<[RegExp, number]> = [
      [/mail|e-mail/, 0],
      [/given|first name|vorname|rufname/, 1],
      [/family|surname|nachname|familienname/, 2],
      [/street|straße|hausnummer|straßenanschrift/, 3],
      [/secondary|apartment|adresszusatz/, 4],
      [/city|town|locality|stadt|ort|gemeinde|lieferort/, 5],
      [/postal|zip|postleitzahl|zustellcode|postgebiet/, 6],
      [/phone|mobile|telefon|mobil|rufnummer/, 7],
      [/country|land|zielland/, 8]
    ];
    for (const [pattern, index] of concepts) {
      if (pattern.test(text)) vector[index] = 1;
    }
    return vector;
  }
}

function formHtml(variant: "A" | "B" | "C"): string {
  const labels = variant === "A"
    ? ["Kontaktmail", "Rufname", "Familienname", "Zustellanschrift Straße und Hausnummer", "Gemeinde", "Zustellcode", "Rufnummer", "Land"]
    : variant === "B"
      ? ["Email for confirmation", "Given name", "Surname", "Street delivery address", "City", "Postal code", "Phone", "Country"]
      : ["E-Mail für die Bestellung", "Vorname", "Nachname", "Straße und Hausnummer", "Lieferort", "Postgebiet", "Mobilnummer", "Zielland"];

  return `<!doctype html><html><body>
    <button id="probe" type="button" onclick="document.body.dataset.clicked='yes'">Pointer probe</button>
    <form style="display:grid;gap:8px;max-width:420px">
      <label>${labels[0]}<input data-slot="email"></label>
      <label>${labels[1]}<input data-slot="firstName"></label>
      <label>${labels[2]}<input data-slot="lastName"></label>
      <label>${labels[3]}<input data-slot="address1"></label>
      <label>${labels[4]}<input data-slot="city"></label>
      <label>${labels[5]}<input data-slot="postalCode"></label>
      <label>${labels[6]}<input data-slot="phone"></label>
      <label>${labels[7]}<select data-slot="countryCode"><option value="">-</option><option value="DE">DE</option><option value="AT">AT</option><option value="CH">CH</option></select></label>
    </form>
  </body></html>`;
}

const sessionValues: Array<{ id: "A" | "B" | "C"; userAgent: string; cookie: string; values: FieldValueMap }> = [
  {
    id: "A",
    userAgent: "ARES-Semantic-Test-A",
    cookie: "cookie-A",
    values: { email: "a@example.test", firstName: "Anna", lastName: "Adler", address1: "A-Weg 1", city: "Berlin", postalCode: "10115", phone: "111", countryCode: "DE" }
  },
  {
    id: "B",
    userAgent: "ARES-Semantic-Test-B",
    cookie: "cookie-B",
    values: { email: "b@example.test", firstName: "Ben", lastName: "Bauer", address1: "B-Road 2", city: "Wien", postalCode: "1010", phone: "222", countryCode: "AT" }
  },
  {
    id: "C",
    userAgent: "ARES-Semantic-Test-C",
    cookie: "cookie-C",
    values: { email: "c@example.test", firstName: "Clara", lastName: "Conrad", address1: "C-Straße 3", city: "Zürich", postalCode: "8001", phone: "333", countryCode: "CH" }
  }
];

describeBrowser("semantic checkout autofill - three isolated sessions", () => {
  jest.setTimeout(45_000);

  it("keeps cookies, user agents and field values isolated and never rewrites successful fields", async () => {
    const server = http.createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body>ARES semantic test</body></html>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch(() => chromium.launch({ headless: true }));

    try {
      const resolver = new FieldSemanticResolver(new IntegrationEmbeddingProvider());
      const results = await Promise.all(sessionValues.map(async session => {
        const context = await browser.newContext({ userAgent: session.userAgent });
        try {
          await context.addCookies([{ name: "ares-session", value: session.cookie, url: origin }]);
          const page = await context.newPage();
          await page.goto(origin);
          await page.setContent(formHtml(session.id));

          const interactions = new GhostCursorUiInteractionHelper(page);
          await interactions.click(page.locator("#probe"));
          expect(await page.locator("body").getAttribute("data-clicked")).toBe("yes");

          const autofill = new SemanticFieldAutofill(page, interactions, resolver);
          await autofill.fillSemantic(session.values);
          await autofill.fillSemantic(session.values); // must be a no-op for already successful fields
          const result = await autofill.result(session.values);

          const values = await page.locator("[data-slot]").evaluateAll(elements => Object.fromEntries(elements.map(element => {
            const control = element as HTMLInputElement | HTMLSelectElement;
            return [control.getAttribute("data-slot") || "", control.value];
          })));

          return {
            id: session.id,
            cookie: await page.evaluate(() => document.cookie),
            userAgent: await page.evaluate(() => navigator.userAgent),
            values,
            result
          };
        } finally {
          await context.close();
        }
      }));

      for (const session of sessionValues) {
        const result = results.find(item => item.id === session.id)!;
        expect(result.cookie).toContain(`ares-session=${session.cookie}`);
        expect(result.userAgent).toBe(session.userAgent);
        expect(result.result.missing).toEqual([]);

        for (const [intent, expected] of Object.entries(session.values)) {
          if (!expected) continue;
          expect(result.values[intent]).toBe(expected);
          expect(result.result.writeCounts[intent]).toBe(1);
        }
      }

      expect(new Set(results.map(item => item.cookie)).size).toBe(3);
      expect(new Set(results.map(item => item.userAgent)).size).toBe(3);
      expect(new Set(results.map(item => item.values["email"])).size).toBe(3);
    } finally {
      await browser.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
