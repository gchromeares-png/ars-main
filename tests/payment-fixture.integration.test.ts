import * as fs from "fs";
import * as path from "path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { CheckoutPaymentPreparer } from "../src/browser-worker/checkout-payment-preparer";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

describeBrowser("local payment fixture", () => {
  jest.setTimeout(30_000);

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" })
      .catch(() => chromium.launch({ headless: true }));
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await context.close();
  });

  it("fills holderName, cardNumber, expiry and securityCode without any order submission", async () => {
    const fixture = fs.readFileSync(
      path.resolve(__dirname, "fixtures/checkout/synthetic/payment-card.html"),
      "utf8"
    );
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });

    const pan = Array.from({ length: 16 }, () => "4").join("");
    const securityCode = ["1", "2", "3"].join("");

    const result = await new CheckoutPaymentPreparer().prepare(page, {
      method: "card",
      card: {
        holderName: "Fixture Holder",
        cardNumber: pan,
        expiry: "12/30",
        securityCode
      }
    });

    expect(await page.locator("#cardholder").inputValue()).toBe("Fixture Holder");
    expect(await page.locator("#card-number").inputValue()).toBe(pan);
    expect(await page.locator("#expiry").inputValue()).toBe("12/30");
    expect(await page.locator("#cvc").inputValue()).toBe(securityCode);
    expect(result.filledFields).toEqual(expect.arrayContaining(["holderName", "cardNumber", "expiry", "securityCode"]));
    expect(result.missingFields).toEqual([]);
    expect(result.requiresUserAction).toBe(true);

    expect(await page.locator('button[type="submit"], input[type="submit"]').count()).toBe(0);
  });
});
