import * as fs from "fs";
import * as path from "path";

describe("runtime hardening safety contracts", () => {
  const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

  it("keeps popup/checkout auto-progress reversible and supports Pure-CDP objects directly", () => {
    const source = read("python/seleniumbase_cdp/consent_popup_handler.py");
    expect(source).toContain("getattr(self._sb, 'cdp', self._sb)");

    const checkoutStart = source.indexOf("_CHECKOUT_TEXT = (");
    const checkoutEnd = source.indexOf("\n)\n\n\nclass ConsentPopupHandler", checkoutStart);
    const checkoutBlock = source.slice(checkoutStart, checkoutEnd);
    for (const finalText of [
      "jetzt kaufen",
      "zahlungspflichtig bestellen",
      "kostenpflichtig bestellen",
      "bestellung abschicken",
      "place order",
      "buy now",
      "pay now",
      "complete purchase",
      "submit order"
    ]) {
      expect(checkoutBlock).not.toContain(finalText);
    }
    expect(source).toContain("if ' ' in candidate and len(candidate) > 8 and candidate in normalized");
  });

  it("recognizes German irreversible-order labels only in the guarded final-submit journey", () => {
    const source = read("src/shopify/checkout-journey.ts");
    expect(source).toContain("/verbindlich bestellen/i");
    expect(source).toContain("/bestellung bestätigen/i");
    expect(source).toContain("/kauf abschließen/i");
    expect(source).toContain("if (!canPurchase()) return false;");
  });

  it("keeps arithmetic deterministic and eval-free", () => {
    const source = read("python/seleniumbase_cdp/instruction_input_runtime.py");
    expect(source).toContain("from decimal import Decimal, InvalidOperation");
    expect(source).toContain("def _infer_arithmetic");
    expect(source).not.toContain("eval(");
  });
});
