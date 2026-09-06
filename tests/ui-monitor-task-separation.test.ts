import * as fs from "fs";
import * as path from "path";

describe("ARES unified task control UX", () => {
  const component = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.ts"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.html"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.scss"), "utf8");
  const runtimeHtml = fs.readFileSync(path.resolve(__dirname, "../src/app/runtime-control/runtime-control.component.html"), "utf8");

  it("creates one monitor-backed task with optional auto-checkout behavior", () => {
    const createStart = component.indexOf("async createTask()");
    const startTaskStart = component.indexOf("async startTask(", createStart + 1);
    const createBlock = component.slice(createStart, startTaskStart);

    expect(createBlock).toContain("productCriteria");
    expect(createBlock).toContain("monitorIntervalMs");
    expect(createBlock).toContain("monitorAction");
    expect(createBlock).toContain('this.taskMode === "auto-checkout"');
    expect(createBlock).toContain("selectedProfileId");
    expect(createBlock).toContain("proxySelection");
    expect(component).not.toContain("async createMonitorTask()");
  });

  it("keeps pure monitoring profile-optional while exposing visible/headless and proxy runtime controls", () => {
    const createStart = component.indexOf("async createTask()");
    const startTaskStart = component.indexOf("async startTask(", createStart + 1);
    const createBlock = component.slice(createStart, startTaskStart);

    expect(createBlock).toContain('mode: "monitor-only"');
    expect(createBlock).toContain("headless: this.headless");
    expect(createBlock).toContain("runtimeProfileId");
    expect(createBlock).toContain("runtimeUserAgent");
    expect(createBlock).toContain("runtimePreferredProxyId");
    expect(createBlock).not.toContain('if (!this.selectedProfileId) {\n        this.error = "Für den Browser-Checkout ist ein Profil erforderlich.";\n        return;\n      }\n    }');
    expect(html).toContain("Runtime profile (optional)");
    expect(html).toContain("Headless browser fallback");
    expect(html).toContain("monitorStrategyMode === 'product-monitor'");
    expect(html).toContain("HTTP fast path; Chromium + full runtime only when HTML is empty or ambiguous.");
  });

  it("uses the command-center sidebar and keeps core modules separate", () => {
    expect(html).toContain('class="nav"');
    expect(html).toContain("<b>Overview</b>");
    expect(html).toContain("<b>Tasks</b>");
    expect(html).toContain("<b>Profiles</b>");
    expect(html).toContain("<b>Proxies</b>");
    expect(html).toContain("<b>Shops</b>");
    expect(html).not.toContain("setTab('monitor')");
    expect(html).toContain(">Identity</button>");
    expect(html).toContain(">Address</button>");
    expect(html).toContain(">Browser</button>");
    expect(html).toContain(">Payment</button>");
  });

  it("exposes monitor-only, auto-checkout and Early Gate while preserving the global purchase guard", () => {
    expect(html).toContain(">Monitor only</button>");
    expect(html).toContain(">Auto checkout</button>");
    expect(html).toContain(">Early gate</button>");
    expect(runtimeHtml).toContain("GLOBAL PURCHASE GUARD");
    expect(runtimeHtml).toContain("FINALER KAUF");
  });

  it("uses the compact dark command-center theme with minimal responsive behavior", () => {
    expect(styles).toContain("#0a0b0d");
    expect(styles).toContain("#4f46e5");
    expect(styles).toContain(".sidebar");
    expect(styles).toContain(".nav");
    expect(styles).toContain("@media (max-width: 1050px)");
    expect(styles).not.toContain("#fff7fb");
    expect(styles).not.toContain("#ff6fa5");
  });

  it("keeps task payment profile-backed without manual card inputs or a task payment disable switch", () => {
    expect(html).toContain("Profile vault + runtime isolation");
    expect(html).not.toContain('[(ngModel)]="taskPaymentEnabled"');
    expect(html).not.toContain('[(ngModel)]="sessionCardNumber"');
    expect(html).not.toContain('[(ngModel)]="sessionCardSecurityCode"');
  });

  it("shows real proxy health actions and diagnostic metrics", () => {
    expect(html).toContain("Proxy config");
    expect(html).toContain("Test all");
    expect(html).toContain("STATUS");
    expect(html).toContain("LATENCY");
    expect(html).toContain("EXIT IP");
    expect(html).toContain("LOCATION");
    expect(component).toContain("async testProxy(proxy: AresProxy)");
    expect(component).toContain("async testAllProxies()");
  });
});
