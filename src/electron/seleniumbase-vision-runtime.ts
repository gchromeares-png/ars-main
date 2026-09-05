import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface SeleniumBaseVisionRuntimeStatus {
  ready: boolean;
  dependenciesReady?: boolean;
  model?: string;
  device?: string;
  error?: string;
}

export class SeleniumBaseVisionRuntime {
  private cachedReady?: SeleniumBaseVisionRuntimeStatus;

  async status(): Promise<SeleniumBaseVisionRuntimeStatus> {
    if (this.cachedReady?.ready) return this.cachedReady;
    return this.run("--status", 30_000);
  }

  async prepare(): Promise<SeleniumBaseVisionRuntimeStatus> {
    if (this.cachedReady?.ready) return this.cachedReady;
    if (process.env["ARES_VISION_AUTO_PREPARE"]?.trim() === "0") return this.status();
    const result = await this.run("--prepare", 10 * 60_000);
    if (result.ready) this.cachedReady = result;
    return result;
  }

  private run(mode: "--status" | "--prepare", timeoutMs: number): Promise<SeleniumBaseVisionRuntimeStatus> {
    const script = this.resolveBootstrapScript();
    const python = process.env["ARES_PYTHON_EXECUTABLE"]?.trim() || "python";
    return new Promise((resolve, reject) => {
      const child = spawn(python, [script, mode], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env }
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => finishError(new Error("ARES Vision Runtime Timeout.")), timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.removeAllListeners();
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
      };
      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (child.exitCode == null) child.kill("SIGTERM");
        reject(error);
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1] || "{}";
        try {
          const value = JSON.parse(last) as SeleniumBaseVisionRuntimeStatus;
          if (!value.ready && stderr.trim() && !value.error) value.error = stderr.trim().slice(-2000);
          resolve(value);
        } catch {
          resolve({ ready: false, error: stderr.trim() || stdout.trim() || "Vision runtime returned no status." });
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
      child.once("error", finishError);
      child.once("exit", finish);
    });
  }

  private resolveBootstrapScript(): string {
    const configured = process.env["ARES_VISION_BOOTSTRAP"]?.trim();
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || "";
    const candidates = [
      configured,
      path.join(process.cwd(), "python", "seleniumbase_cdp", "vision_runtime_bootstrap.py"),
      path.join(__dirname, "../../python/seleniumbase_cdp/vision_runtime_bootstrap.py"),
      resourcesPath ? path.join(resourcesPath, "python", "seleniumbase_cdp", "vision_runtime_bootstrap.py") : undefined
    ].filter((value): value is string => Boolean(value));
    const script = candidates.find(candidate => fs.existsSync(candidate));
    if (!script) throw new Error("ARES Vision Bootstrap wurde nicht gefunden.");
    return script;
  }
}
