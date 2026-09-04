import { ShopifyPaymentPreparer } from "../src/shopify/payment-preparer";

function locator(options: {
  visible?: boolean;
  text?: string;
  onClick?: () => void;
  onFill?: (value: string) => void;
} = {}): any {
  const self: any = {
    first: () => self,
    filter: () => self,
    isVisible: async () => Boolean(options.visible),
    click: async () => options.onClick?.(),
    fill: async (value: string) => options.onFill?.(value),
    selectOption: async (value: string) => options.onFill?.(value),
    innerText: async () => options.text ?? ""
  };
  return self;
}

describe("Shopify payment preparation", () => {
  it("detects visible payment methods without attempting checkout submission", async () => {
    const frame: any = {
      locator: (selector: string) => selector === "body"
        ? locator({ visible: true, text: "Credit card PayPal Klarna Shop Pay" })
        : locator({ visible: selector.includes('cc-number') }),
      getByRole: () => locator()
    };
    const page: any = { frames: () => [frame] };

    const result = await new ShopifyPaymentPreparer().prepare(page);

    expect(result.detectedMethods).toEqual(expect.arrayContaining(["card", "paypal", "klarna", "shop-pay"]));
    expect(result.requiresUserAction).toBe(true);
    expect(result.selectedMethod).toBeUndefined();
  });

  it("selects card by radio and fills the existing checkout card fields", async () => {
    const clicked: string[] = [];
    const filled: Record<string, string> = {};
    const pan = Array.from({ length: 16 }, () => "4").join("");
    const securityCode = ["1", "2", "3"].join("");

    const mainFrame: any = {
      locator: (selector: string) => {
        if (selector === "body") return locator({ visible: true, text: "Credit card" });
        if (selector === "label" || selector === '[role="radio"]') return locator();
        return locator();
      },
      getByRole: (role: string, options: { name?: RegExp }) => locator({
        visible: role === "radio" && Boolean(options.name?.test("Credit card")),
        onClick: () => clicked.push("card-radio")
      })
    };

    const cardFrame: any = {
      locator: (selector: string) => {
        if (selector === "body") return locator({ visible: true, text: "" });
        const mapping: Array<[string, string]> = [
          ['cc-name', "holderName"],
          ['cc-number', "cardNumber"],
          ['cc-exp', "expiry"],
          ['cc-csc', "securityCode"]
        ];
        const match = mapping.find(([needle]) => selector.includes(needle));
        return match
          ? locator({ visible: true, onFill: value => { filled[match[1]] = value; } })
          : locator();
      },
      getByRole: () => locator()
    };

    const page: any = { frames: () => [mainFrame, cardFrame] };
    const result = await new ShopifyPaymentPreparer().prepare(page, {
      method: "card",
      card: {
        holderName: "Test Holder",
        cardNumber: pan,
        expiry: "12/30",
        securityCode
      }
    });

    expect(clicked).toEqual(["card-radio"]);
    expect(result.selectedMethod).toBe("card");
    expect(result.missingFields).toEqual([]);
    expect(result.filledFields).toEqual(expect.arrayContaining(["holderName", "cardNumber", "expiry", "securityCode"]));
    expect(filled).toEqual({
      holderName: "Test Holder",
      cardNumber: pan,
      expiry: "12/30",
      securityCode
    });
    expect(result.requiresUserAction).toBe(true);
  });

  it("never contains generic payment-button or submit activation", () => {
    const source = require("fs").readFileSync(require("path").resolve(__dirname, "../src/shopify/payment-preparer.ts"), "utf8");
    expect(source).not.toContain('getByRole("button"');
    expect(source).not.toMatch(/\.submit\s*\(/);
    expect(source).not.toMatch(/press\([^)]*Enter/i);
  });
});
