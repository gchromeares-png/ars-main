import { Component, OnInit } from "@angular/core";

interface KeyStatus {
  configured: boolean;
  source: "process-env" | ".env.txt" | ".env" | "none";
}

interface KeyTestResult extends KeyStatus {
  success: boolean;
  valid: boolean;
  balance?: number;
  latencyMs?: number;
  error?: string;
}

@Component({
  selector: "app-api-key-status",
  templateUrl: "./api-key-status.component.html",
  styleUrls: ["./api-key-status.component.scss"]
})
export class ApiKeyStatusComponent implements OnInit {
  status: KeyStatus = { configured: false, source: "none" };
  testResult?: KeyTestResult;
  testing = false;

  ngOnInit(): void {
    this.refreshStatus();
  }

  refreshStatus(): void {
    try {
      const result = (window as any).ares?.getCapmonsterApiKeyStatus?.();
      if (result && typeof result.configured === "boolean") this.status = result;
    } catch {
      this.status = { configured: false, source: "none" };
    }
  }

  async testKey(): Promise<void> {
    if (this.testing) return;
    this.testing = true;
    this.testResult = undefined;
    try {
      const result = await (window as any).ares?.testCapmonsterApiKey?.();
      if (result) {
        this.testResult = result;
        this.status = { configured: result.configured === true, source: result.source || "none" };
      }
    } catch (error) {
      this.testResult = {
        success: false,
        configured: this.status.configured,
        valid: false,
        source: this.status.source,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.testing = false;
    }
  }

  get sourceLabel(): string {
    if (this.status.source === "process-env") return "Prozess-Umgebung";
    if (this.status.source === ".env.txt") return ".env.txt";
    if (this.status.source === ".env") return ".env";
    return "nicht gefunden";
  }

  get testLabel(): string {
    if (!this.testResult) return "Noch nicht getestet";
    if (this.testResult.valid) return "GÜLTIG";
    return "FEHLER";
  }
}
