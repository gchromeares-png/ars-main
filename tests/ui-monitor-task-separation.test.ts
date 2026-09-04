import * as fs from "fs";
import * as path from "path";

describe("ARES unified task control UX", () => {
  const component = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.ts"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.html"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.scss"), "utf8");

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

  it("uses the left sidebar and keeps profiles, proxies and shops separate", () => {
    expect(html).toContain("side-nav");
    expect(html).toContain("<span>Overview</span>");
    expect(html).toContain("<span>Watch</span>");
    expect(html).toContain("<span>Profiles</span>");
    expect(html).toContain("<span>Proxys</span>");
    expect(html).toContain("<span>Shops</span>");
    expect(html).not.toContain("setTab('monitor')");
    expect(html).toContain(">Persönlich</button>");
    expect(html).toContain(">Adressen</button>");
    expect(html).toContain(">Browser</button>");
    expect(html).toContain(">Zahlung</button>");
  });

  it("exposes monitor-only, auto-checkout and Early Gate with global purchase control", () => {
    expect(html).toContain("Nur beobachten");
    expect(html).toContain("Checkout vorbereiten");
    expect(html).toContain("Early Gate");
    expect(html).toContain("GLOBAL AUS");
    expect(html).toContain("Finaler Kauf");
  });

  it("uses the compact graphite/lime control theme with minimal responsive behavior", () => {
    expect(styles).toContain("#090a09");
    expect(styles).toContain("#b7df5c");
    expect(styles).toContain(".sidebar");
    expect(styles).toContain("@media (max-width: 1180px)");
    expect(styles).not.toContain("@media (max-width: 820px)");
    expect(styles).not.toContain("#fff7fb");
    expect(styles).not.toContain("#ff6fa5");
  });

  it("keeps task payment profile-backed without manual card inputs", () => {
    expect(html).toContain("Profil-Zahlung ist immer aktiv");
    expect(html).toContain("PROFILE VAULT");
    expect(html).toContain("Es gibt keinen Klartext-Fallback im Task");
    expect(html).not.toContain('[(ngModel)]="sessionCardNumber"');
    expect(html).not.toContain('[(ngModel)]="sessionCardSecurityCode"');
    expect(html).not.toContain('[(ngModel)]="taskPaymentEnabled"');
  });

  it("shows real proxy health actions and diagnostic metrics", () => {
    expect(html).toContain("PROXY CONFIG");
    expect(html).toContain("Alle testen");
    expect(html).toContain("STATUS");
    expect(html).toContain("LATENCY");
    expect(html).toContain("EXIT IP");
    expect(html).toContain("LOCATION");
    expect(component).toContain("async testProxy(proxy: AresProxy)");
    expect(component).toContain("async testAllProxies()");
  });
});
