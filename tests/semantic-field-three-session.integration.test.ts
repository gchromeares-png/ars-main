import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { AresBrowserRuntime } from "../src/browser-worker/ares-browser-runtime";
import type { SemanticEmbeddingProvider } from "../src/browser-worker/field-semantic-resolver";
import { FieldSemanticResolver } from "../src/browser-worker/field-semantic-resolver";
import { SemanticFieldAutofill } from "../src/browser-worker/semantic-field-autofill";
import { semanticTarget, targetKey, type AddressContext, type FieldIntent } from "../src/browser-worker/semantic-target";
import { SemanticTargetValueMap } from "../src/browser-worker/semantic-target-values";
import { GhostCursorUiInteractionHelper } from "../src/browser-worker/ui-interaction-helper";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

type SessionValueRecord = Partial<Record<Exclude<FieldIntent, "unknown">, string>>;

class IntegrationEmbeddingProvider implements SemanticEmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.vector(text.toLowerCase()));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(14).fill(0.01);
    const concepts: Array<[RegExp, number]> = [
      [/mail|e-mail/, 0],
      [/given|first name|vorname|rufname/, 1],
      [/family|surname|nachname|familienname/, 2],
      [/full name|vollständiger name|empfängername/, 3],
      [/street name without|straße ohne/, 4],
      [/primary address|street delivery address|straße und hausnummer|zustellanschrift/, 5],
      [/house number|hausnummer/, 6],
      [/secondary|apartment|adresszusatz/, 7],
      [/city|town|locality|stadt|ort|gemeinde|lieferort/, 8],
      [/postal|zip|postleitzahl|zustellcode|postgebiet/, 9],
      [/phone|mobile|telefon|mobil|rufnummer/, 10],
      [/country|land|zielland/, 11],
      [/shipping|delivery|liefer|zustell|versand/, 12],
      [/billing|invoice|rechnung/, 13]
    ];
    for (const [pattern, index] of concepts) if (pattern.test(text)) vector[index] = 1;
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

function semanticValues(values: SessionValueRecord): SemanticTargetValueMap {
  const entries = [] as Array<{ target: ReturnType<typeof semanticTarget>; value: string }>;
  const contexts: AddressContext[] = ["shipping", "billing", "unknown"];
  for (const [intent, value] of Object.entries(values) as Array<[Exclude<FieldIntent, "unknown">, string | undefined]>) {
    if (!value) continue;
    for (const context of contexts) entries.push({ target: semanticTarget(intent, context), value });
  }
  return new SemanticTargetValueMap(entries);
}

const sessionValues: Array<{ id: "A" | "B" | "C"; userAgent: string; cookie: string; values: SessionValueRecord }> = [
  { id: "A", userAgent: "ARES-Semantic-Test-A", cookie: "cookie-A", values: { email: "a@example.test", firstName: "Anna", lastName: "Adler", address1: "A-Weg 1", city: "Berlin", postalCode: "10115", phone: "111", countryCode: "DE" } },
  { id: "B", userAgent: "ARES-Semantic-Test-B", cookie: "cookie-B", values: { email: "b@example.test", firstName: "Ben", lastName: "Bauer", address1: "B-Road 2", city: "Wien", postalCode: "1010", phone: "222", countryCode: "AT" } },
  { id: "C", userAgent: "ARES-Semantic-Test-C", cookie: "cookie-C", values: { email: "c@example.test", firstName: "Clara", lastName: "Conrad", address1: "C-Straße 3", city: "Zürich", postalCode: "8001", phone: "333", countryCode: "CH" } }
];

describeBrowser("semantic checkout autofill - three isolated sessions", () => {
  jest.setTimeout(60_000);

  it("keeps cookies, user agents and field values isolated and never rewrites successful targets", async () => {
    const server = http.createServer((request, response) => {
      const variant = String(request.url || "/A").replace(/^\//, "").toUpperCase();
      const id = variant === "B" || variant === "C" ? variant : "A";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(formHtml(id));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const runtime = new AresBrowserRuntime();
    const dirs: string[] = [];

    try {
      const resolver = new FieldSemanticResolver(new IntegrationEmbeddingProvider());
      const results = await Promise.all(sessionValues.map(async session => {
        const taskId = `semantic-session-${session.id}-${Date.now()}`;
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `ares-semantic-${session.id}-`));
        dirs.push(userDataDir);
        runtime.setTaskCookieSnapshot(taskId, [{ name: "ares-session", value: session.cookie, url: origin }]);
        const handle = await runtime.createContext({ taskId, userDataDir, headless: true, userAgent: session.userAgent });
        try {
          const page = handle.page;
          await page.goto(`${origin}/${session.id}`, { waitUntil: "domcontentloaded" });

          const interactions = new GhostCursorUiInteractionHelper(page);
          await interactions.click(page.locator("#probe"));
          expect(await page.evaluate(() => document.body.dataset.clicked)).toBe("yes");

          const source = semanticValues(session.values);
          const autofill = new SemanticFieldAutofill(page, interactions, resolver);
          await autofill.fillSemantic(source);
          await autofill.fillSemantic(source);
          const result = await autofill.result(source);

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
          await runtime.closeContext(taskId);
        }
      }));

      for (const session of sessionValues) {
        const result = results.find(item => item.id === session.id)!;
        expect(result.cookie).toContain(`ares-session=${session.cookie}`);
        expect(result.userAgent).toBe(session.userAgent);
        expect(result.result.missing).toEqual([]);
        for (const [intent, expected] of Object.entries(session.values)) if (expected) expect(result.values[intent]).toBe(expected);
        for (const target of result.result.filled) expect(result.result.writeCounts[targetKey(target)]).toBe(1);
      }

      expect(new Set(results.map(item => item.cookie)).size).toBe(3);
      expect(new Set(results.map(item => item.userAgent)).size).toBe(3);
      expect(new Set(results.map(item => item.values["email"])).size).toBe(3);
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});