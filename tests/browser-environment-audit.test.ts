import * as fs from "fs";
import * as path from "path";
import { classifyBrowserEnvironment } from "../src/browser-worker/browser-environment-audit";
import type { BrowserEnvironmentSnapshot } from "../src/browser-worker/types";

function snapshot(overrides: Partial<BrowserEnvironmentSnapshot> = {}): BrowserEnvironmentSnapshot {
  return {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36",
    platform: "Win32",
    language: "de-DE",
    languages: ["de-DE", "de"],
    timezone: "Europe/Berlin",
    hardwareConcurrency: 16,
    deviceMemory: 8,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1 },
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ...overrides
  };
}

describe("browser environment consistency audit", () => {
  test("accepts a coherent Windows/Win32/ANGLE hardware profile", () => {
    const audit = classifyBrowserEnvironment(snapshot(), "2026-09-04T00:00:00.000Z");
    expect(audit.status).toBe("green"); expect(audit.userAgentOs).toBe("windows"); expect(audit.platformOs).toBe("windows"); expect(audit.issues).toEqual([]);
  });
  test("warns when a Windows user agent reports Linux platform and Mesa software rendering", () => {
    const audit = classifyBrowserEnvironment(snapshot({ platform: "Linux x86_64", webglVendor: "Mesa/X.org", webglRenderer: "llvmpipe (LLVM 18.1.8, 256 bits)" }));
    expect(audit.status).toBe("warning");
    expect(audit.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["ua-platform-mismatch", "software-renderer", "windows-mesa-renderer"]));
  });
  test("warns for SwiftShader even when user agent and platform match", () => {
    const audit = classifyBrowserEnvironment(snapshot({ webglVendor: "Google Inc. (Google)", webglRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" }));
    expect(audit.status).toBe("warning"); expect(audit.issues.map(issue => issue.code)).toContain("software-renderer"); expect(audit.issues.map(issue => issue.code)).not.toContain("ua-platform-mismatch");
  });
  test("does not treat ordinary Mesa hardware rendering on Linux as a mismatch", () => {
    const audit = classifyBrowserEnvironment(snapshot({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36", platform: "Linux x86_64", webglVendor: "Intel", webglRenderer: "Mesa Intel(R) UHD Graphics 770 (RPL-S)" }));
    expect(audit.status).toBe("green");
  });
  test("wires the audit into SeleniumBase runtime, Early Gate runtime and Drop Setup status", () => {
    const root = path.join(__dirname, "..");
    const worker = fs.readFileSync(path.join(root, "src/browser-worker/seleniumbase-browser-worker.ts"), "utf8");
    const earlyGate = fs.readFileSync(path.join(root, "src/browser-worker/early-gate-task-executor.ts"), "utf8");
    const dropUi = fs.readFileSync(path.join(root, "src/app/drop-setups/drop-setups.component.ts"), "utf8");
    expect(worker).toContain("collectBrowserEnvironment(page)");
    expect(earlyGate).toContain("browserEnvironment: handle.environmentAudit");
    expect(dropUi).toContain("Env GRÜN"); expect(dropUi).toContain("Env WARNUNG");
  });
});
