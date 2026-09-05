import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AresBrowserRuntime } from "../src/browser-worker/ares-browser-runtime";
import { CheckoutPaymentPreparer } from "../src/browser-worker/checkout-payment-preparer";

const describeBrowser = process.env["ARES_RUN_BROWSER_INTEGRATION"] === "1" ? describe : describe.skip;

describeBrowser("local payment fixture", () => {
  jest.setTimeout(45_000);

  const runtime = new AresBrowserRuntime();
  let taskId = "";
  let userDataDir = "";

  afterEach(async () => {
    if (taskId) await runtime.closeContext(taskId).catch(() => undefined);
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    taskId = "";
    userDataDir = "";
  });

  afterAll(async () => {
    await runtime.shutdown();
  });

  it("fills holderName, cardNumber, expiry and securityCode without any order submission", async () => {
    const fixture = fs.readFileSync(
      path.resolve(__dirname, "fixtures/checkout/synthetic/payment-card.html"),
      "utf8"
    );

    taskId = `payment-fixture-${Date.now()}`;
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ares-payment-fixture-"));
    const handle = await runtime.createContext({
      taskId,
      userDataDir,
      headless: true,
      navigationTimeoutMs: 30_000,
      actionTimeoutMs: 15_000
    });
    const page = handle.page;

    // This is a synthetic local DOM fixture, not a shop navigation. Loading it through
    // page.goto() would intentionally enter the protected ARES navigation/challenge
    // pipeline. Keep that production sequence untouched and inject the fixture into the
    // READY about:blank document so this test isolates RPC locator/fill semantics.
    await page.evaluate((html: string) => {
      document.open();
      document.write(html);
      document.close();
      return document.readyState;
    }, fixture);

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
