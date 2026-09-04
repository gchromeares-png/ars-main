import { spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import * as path from "path";
import type { AresProfile } from "../profiles/models";
import type { AresProxy } from "../proxies/models";
import type { BrowserProxyConfig } from "../browser-worker/types";
import type { ProfileCookieSnapshotCookie } from "../cookies/profile-cookie-snapshot-vault";
import { resolveProfileUserDataDir } from "../browser-worker/profile-session-manager";
import { registerProfilePaymentIpc } from "./profile-payment-controller";
import { registerProfileCookieSnapshotIpc } from "./profile-cookie-snapshot-controller";

interface ManualBrowserSession {
  profileId: string;
  child: ChildProcessWithoutNullStreams;
  userDataDir: string;
  startedAt: string;
}

export interface ProfileBrowserStatus {
  profileId: string;
  open: boolean;
  pid?: number;
  userDataDir: string;
  startedAt?: string;
}

interface ManualBrowserWireMessage {
  type?: string;
  requestId?: string;
  profileId?: string;
  pid?: number;
  userDataDir?: string;
  cookies?: ProfileCookieSnapshotCookie[];
  error?: string;
}

export class ProfileBrowserController {
  private readonly sessions = new Map<string, ManualBrowserSession>();

  constructor(
    private readonly profileRoot: string,
    private readonly getProxy: (proxyId: string) => AresProxy | undefined
  ) {
    const userDataRoot = path.dirname(profileRoot);
    registerProfilePaymentIpc(userDataRoot);
    registerProfileCookieSnapshotIpc(userDataRoot, this);
  }

  async open(profile: AresProfile, startUrl?: string): Promise<ProfileBrowserStatus> {
    const profileId = String(profile.id ?? "").trim();
    if (!profileId) throw new Error("Profil-ID fehlt.");
    const existing = this.sessions.get(profileId);
    if (existing && existing.child.exitCode == null) return this.status(profileId);

    const userDataDir = resolveProfileUserDataDir(profileId, this.profileRoot);
    const workerScript = path.join(__dirname, "../browser-worker/manual-profile-browser.js");
    const nodeExecutable = process.env["ARES_NODE_EXECUTABLE"]?.trim() || "node";
    const child = spawn(nodeExecutable, [workerScript], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, ARES_BROWSER_PROFILE_ROOT: this.profileRoot }
    });

    const session: ManualBrowserSession = { profileId, child, userDataDir, startedAt: new Date().toISOString() };
    this.sessions.set(profileId, session);
    child.once("exit", () => { if (this.sessions.get(profileId)?.child === child) this.sessions.delete(profileId); });

    const proxy = this.resolveProxy(profile);
    const payload = { type: "start", profileId, userDataDir, proxy, userAgent: profile.browser?.userAgent || undefined, startUrl: startUrl?.trim() || undefined };

    return new Promise<ProfileBrowserStatus>((resolve, reject) => {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let settled = false;
      const timeout = setTimeout(() => finishError(new Error("Profil-Browser Start Timeout.")), 20_000);
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.removeListener("error", onError);
        child.removeListener("exit", onEarlyExit);
      };
      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true; cleanup(); this.sessions.delete(profileId);
        if (child.exitCode == null) child.kill("SIGTERM");
        reject(error);
      };
      const finishSuccess = (message: ManualBrowserWireMessage): void => {
        if (settled) return;
        settled = true; cleanup();
        resolve({ profileId, open: true, pid: message.pid ?? child.pid, userDataDir: message.userDataDir || userDataDir, startedAt: session.startedAt });
      };
      const onError = (error: Error): void => finishError(error);
      const onEarlyExit = (code: number | null): void => {
        const detail = stderrBuffer.trim();
        finishError(new Error(`Profil-Browser wurde vor dem Start beendet (code=${String(code)}).${detail ? ` ${detail}` : ""}`));
      };
      const onStderr = (chunk: unknown): void => { stderrBuffer = `${stderrBuffer}${String(chunk)}`.slice(-2_000); };
      const onStdout = (chunk: unknown): void => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let message: ManualBrowserWireMessage;
          try { message = JSON.parse(line) as ManualBrowserWireMessage; } catch { continue; }
          if (message.type === "ready") { finishSuccess(message); return; }
          if (message.type === "error") { finishError(new Error(message.error || "Profil-Browser konnte nicht gestartet werden.")); return; }
        }
      };
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stderr.on("data", onStderr); child.stdout.on("data", onStdout);
      child.once("error", onError); child.once("exit", onEarlyExit);
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async captureCookies(profileId: string): Promise<ProfileCookieSnapshotCookie[]> {
    const id = String(profileId ?? "").trim();
    const session = this.sessions.get(id);
    if (!session || session.child.exitCode != null) throw new Error("Profil-Browser muss geöffnet sein, bevor Cookies gespeichert werden können.");

    const child = session.child;
    const requestId = randomUUID();
    return new Promise<ProfileCookieSnapshotCookie[]>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const timeout = setTimeout(() => finishError(new Error("Cookie-Snapshot Timeout.")), 10_000);
      const cleanup = (): void => {
        clearTimeout(timeout); child.stdout.removeListener("data", onData); child.removeListener("exit", onExit); child.removeListener("error", onError);
      };
      const finishError = (error: Error): void => { if (settled) return; settled = true; cleanup(); reject(error); };
      const finishSuccess = (cookies: ProfileCookieSnapshotCookie[]): void => { if (settled) return; settled = true; cleanup(); resolve(cookies); };
      const onExit = (): void => finishError(new Error("Profil-Browser wurde während des Cookie-Snapshots beendet."));
      const onError = (error: Error): void => finishError(error);
      const onData = (chunk: unknown): void => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let message: ManualBrowserWireMessage;
          try { message = JSON.parse(line) as ManualBrowserWireMessage; } catch { continue; }
          if (message.requestId !== requestId) continue;
          if (message.type === "cookies") { finishSuccess(Array.isArray(message.cookies) ? message.cookies : []); return; }
          if (message.type === "error") { finishError(new Error(message.error || "Cookies konnten nicht gelesen werden.")); return; }
        }
      };
      child.stdout.on("data", onData); child.once("exit", onExit); child.once("error", onError);
      child.stdin.write(`${JSON.stringify({ type: "export-cookies", requestId })}\n`, error => { if (error) finishError(error); });
    });
  }

  async close(profileId: string): Promise<ProfileBrowserStatus> {
    const id = String(profileId ?? "").trim();
    const session = this.sessions.get(id);
    if (!session) return this.status(id);
    const child = session.child;
    this.sessions.delete(id);
    if (child.exitCode == null) {
      try { child.stdin.write(`${JSON.stringify({ type: "close" })}\n`); } catch {}
      const graceful = await this.waitForExit(child, 8_000);
      if (!graceful && child.exitCode == null) {
        child.kill("SIGTERM");
        const terminated = await this.waitForExit(child, 2_000);
        if (!terminated && child.exitCode == null) child.kill("SIGKILL");
      }
    }
    return this.status(id);
  }

  status(profileId: string): ProfileBrowserStatus {
    const id = String(profileId ?? "").trim();
    const session = this.sessions.get(id);
    const open = Boolean(session && session.child.exitCode == null);
    return { profileId: id, open, pid: open ? session?.child.pid : undefined, userDataDir: resolveProfileUserDataDir(id, this.profileRoot), startedAt: open ? session?.startedAt : undefined };
  }
  isOpen(profileId: string): boolean { return this.status(profileId).open; }
  async closeAll(): Promise<void> { await Promise.allSettled([...this.sessions.keys()].map(profileId => this.close(profileId))); }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode != null) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (exited: boolean): void => { if (settled) return; settled = true; clearTimeout(timeout); child.removeListener("exit", onExit); resolve(exited); };
      const onExit = (): void => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
    });
  }

  private resolveProxy(profile: AresProfile): BrowserProxyConfig | undefined {
    const preferredProxyId = profile.preferredProxyId?.trim();
    if (preferredProxyId) {
      const proxy = this.getProxy(preferredProxyId);
      if (!proxy) throw new Error(`Standard-Proxy ${preferredProxyId} existiert nicht mehr.`);
      return { protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password };
    }
    if (!profile.proxy?.host || !profile.proxy.port) return undefined;
    return { protocol: profile.proxy.protocol || "http", host: profile.proxy.host, port: profile.proxy.port, username: profile.proxy.username || undefined, password: profile.proxy.password || undefined };
  }
}
