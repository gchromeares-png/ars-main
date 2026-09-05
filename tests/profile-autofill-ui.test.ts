import * as fs from "fs";
import * as path from "path";

describe("Profile assignment and checkout autofill", () => {
  const component = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.ts"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.html"), "utf8");
  const executor = fs.readFileSync(path.resolve(__dirname, "../src/shopify/shopify-task-executor.ts"), "utf8");

  it("requires and stores a selected profile for each new task", () => {
    expect(html).toContain('[(ngModel)]="selectedProfileId"');
    expect(component).toContain("!this.selectedProfileId");
    expect(component).toContain("profileId: this.selectedProfileId");
  });

  it("calls profile autofill after queue-aware checkout navigation", () => {
    const checkoutNavigation = "await this.navigateWithQueueSupport(page, checkoutUrl, task)";
    const autofill = "await this.fillCheckoutProfile(page, profile)";
    expect(executor).toContain(checkoutNavigation);
    expect(executor).toContain(autofill);
    expect(executor.indexOf(autofill)).toBeGreaterThan(executor.indexOf(checkoutNavigation));
    expect(executor).toContain("finalPaymentSubmitted: false");
  });

  it("keeps a task-specific persistent SeleniumBase browser session", () => {
    expect(executor).toContain("SeleniumBaseBrowserWorker");
    expect(executor).toContain("ares-browser-profiles");
    expect(executor).toContain("userDataDir");
  });
});
