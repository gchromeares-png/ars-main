import * as fs from "fs";
import * as path from "path";

describe("Profile assignment and checkout autofill", () => {
  const component = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.ts"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.html"), "utf8");
  const executor = fs.readFileSync(path.resolve(__dirname, "../src/shopify/patchright-shopify-executor.ts"), "utf8");

  it("requires and stores a selected profile for each new task", () => {
    expect(html).toContain('[(ngModel)]="selectedProfileId"');
    expect(component).toContain("!this.selectedProfileId");
    expect(component).toContain("profileId: this.selectedProfileId");
  });

  it("calls profile autofill after checkout is opened", () => {
    expect(executor).toContain('await page.goto(checkoutUrl');
    expect(executor).toContain("await this.fillCheckoutProfile(page, profile)");
    expect(executor).toContain("finalPaymentSubmitted: false");
  });

  it("keeps a task-specific persistent browser session", () => {
    expect(executor).toContain("ares-browser-profiles");
    expect(executor).toContain("userDataDir");
  });
});
