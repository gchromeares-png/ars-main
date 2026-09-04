import * as fs from "fs";
import * as path from "path";

describe("Drop Setup progressive UI", () => {
  const component = fs.readFileSync(path.resolve(__dirname, "../src/app/drop-setups/drop-setups.component.ts"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../src/app/drop-setups/drop-setups.component.html"), "utf8");
  const styles = fs.readFileSync(path.resolve(__dirname, "../src/app/drop-setups/drop-setups.component.scss"), "utf8");
  const appModule = fs.readFileSync(path.resolve(__dirname, "../src/app/app.module.ts"), "utf8");

  it("replaces the legacy task builder with a progressive Drop Setup component", () => {
    expect(appModule).toContain("DropSetupsComponent");
    expect(component).toContain('selector: ".task-builder"');
    expect(html).toContain("Drop Setups");
    expect(html).toContain("Shop & Strategie");
    expect(html).toContain("Produkt & Keywords");
    expect(html).toContain("Profile & Proxys");
    expect(html).toContain("Speichern & Starten");
  });

  it("persists setup metadata but keeps sensitive payment values outside the saved setup", () => {
    const setupInterfaceStart = component.indexOf("interface DropSetup");
    const feedbackStart = component.indexOf("interface LocalFeedback", setupInterfaceStart);
    const setupInterface = component.slice(setupInterfaceStart, feedbackStart);

    expect(component).toContain('storageKey = "ares.dropSetups.v1"');
    expect(component).toContain("localStorage.setItem(this.storageKey, JSON.stringify(this.setups))");
    expect(setupInterface).not.toContain("cardNumber");
    expect(setupInterface).not.toContain("securityCode");
    expect(component).toContain("sessionCardNumber");
    expect(component).toContain("clearSensitivePaymentInputs()");
    expect(html).toContain("RAM-only");
  });

  it("creates one parent monitor task per selected profile and supports staggered starts", () => {
    expect(component).toContain("for (let index = 0; index < setup.assignments.length; index += 1)");
    expect(component).toContain("await this.delay(setup.staggerMs)");
    expect(component).toContain("dropSetupId: setup.id");
    expect(component).toContain('mode: "auto-checkout"');
    expect(component).toContain("profileId: assignment.profileId");
    expect(component).toContain("proxySelection: assignment.proxySelection");
    expect(component).toContain("await this.electron.startTask(taskId)");
  });

  it("keeps runtime details collapsed until a run is opened and supports live discovery keywords", () => {
    expect(html).toContain("Profile | Proxy | Status | Öffnen");
    expect(html).toContain("Timeline / Logs");
    expect(html).toContain("Browser Child");
    expect(html).toContain("Live Discovery-Keywords");
    expect(component).toContain("POST_QUEUE_DISCOVERY");
    expect(component).toContain("updateDiscoveryKeywords");
  });

  it("uses the dark samurai theme with readable secondary text", () => {
    expect(styles).toContain("samuraiFall");
    expect(styles).toContain("#080707");
    expect(styles).toContain("#7e171b");
    expect(styles).toContain("#7d4720");
    expect(styles).toContain(".app-shell small { font-size: 12px");
  });
});
