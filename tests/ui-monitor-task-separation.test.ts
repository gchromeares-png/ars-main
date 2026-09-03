import * as fs from "fs";
import * as path from "path";

describe("ARES tabbed task UX", () => {
  const component = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.ts"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.html"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.scss"), "utf8");

  it("separates monitor creation from browser task creation", () => {
    const monitorStart = component.indexOf("async createMonitorTask()");
    const browserStart = component.indexOf("async createTask()", monitorStart + 1);
    const startTaskStart = component.indexOf("async startTask(", browserStart + 1);

    const monitorBlock = component.slice(monitorStart, browserStart);
    const browserBlock = component.slice(browserStart, startTaskStart);

    expect(monitorBlock).toContain("productCriteria");
    expect(monitorBlock).toContain("monitorIntervalMs");
    expect(monitorBlock).not.toContain("selectedProfileId");

    expect(browserBlock).toContain("!this.selectedProfileId");
    expect(browserBlock).toContain("searchTerm: this.searchTerm.trim()");
    expect(browserBlock).not.toContain("productCriteria");
  });

  it("provides top-level tabs and profile subtabs", () => {
    expect(html).toContain("Dashboard</button>");
    expect(html).toContain("Monitor</button>");
    expect(html).toContain("Tasks</button>");
    expect(html).toContain("Profile</button>");
    expect(html).toContain("Shops</button>");
    expect(html).toContain("Persönlich</button>");
    expect(html).toContain("Adresse</button>");
    expect(html).toContain("Browser & Proxy</button>");
    expect(html).toContain("Zahlung</button>");
  });

  it("uses a dark leaf theme instead of the previous pink base", () => {
    expect(styles).toContain("leafFall");
    expect(styles).toContain("#0b0f0d");
    expect(styles).not.toContain("#fff7fb");
    expect(styles).not.toContain("#ff6fa5");
  });

  it("keeps card data session-only in the browser-task area", () => {
    expect(html).toContain("NICHT PERSISTIERT");
    expect(html).toContain('[(ngModel)]="sessionCardNumber"');
    expect(html).toContain('[(ngModel)]="sessionCardSecurityCode"');
    expect(component).toContain("setPaymentSession(taskId");
    expect(component).toContain("clearSensitivePaymentInputs()");
  });
});
