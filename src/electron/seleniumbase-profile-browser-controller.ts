import { spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { chromium } from "patchright";
import type { Browser, BrowserContext, Page } from "patchright";
import type { AresProfile } from "../profiles/models";
import type { AresProxy } from "../proxies/models";
import type { BrowserProxyConfig } from "../browser-worker/types";
import type { ProfileCookieSnapshotCookie, ProfileCookieSnapshotSummary } from "../cookies/profile-cookie-snapshot-vault";
import {
  readRegisteredProfileCookieSnapshot,
  saveRegisteredProfileCookieSnapshot
} from "../cookies/profile-cookie-snapshot-registry";
import { resolveProfileUserDataDir } from "../browser-worker/profile-session-manager";

const WIRE_PREFIX = "ARES_SB_MANUAL\t";
const SELENIUMBASE_PROFILE_DIR = ".ares-seleniumbase-cdp";
const POST_NAVIGATION_CAPTCHA_DELAY_MS = 2_000;

interface SeleniumBaseManualSession {
  profileId: string;
  child: ChildProcessWithoutNullStreams;
  userDataDir: string;
  startedAt: string;
  appliedSnapshotId?: string;
  cdpEndpoint?: string;
  patchrightBrowser?: Browser;
  patchrightContext?: BrowserContext;
  patchrightPage?: Page;
}

interface SeleniumBaseWireMessage {
  type?: string;
  requestId?: string;
  profileId?: string;
  profileDir?: string;
  pid?: number;
  open?: boolean;
  count?: number;
  appliedCookieCount?: number;
  cookies?: ProfileCookieSnapshotCookie[];
  endpointUrl?: string;
  error?: string;
}

export interface SeleniumBaseProfileBrowserStatus {
  engine: "seleniumbase-cdp";
  profileId: string;
  open: boolean;
  pid?: number;
  userDataDir: string;
  startedAt?: string;
  appliedSnapshotId?: string;
}

export interface SeleniumBasePatchrightNavigationResult {
  endpointUrl: string;
  url: string;
  title: string;
}

export class SeleniumBaseProfileBrowserController {
  private readonly sessions = new Map<string, SeleniumBaseManualSession>();

  constructor(
    private readonly profileRoot: string,
    private readonly getProxy: (proxyId: string) => AresProxy | undefined
  ) {}

  async open(
    profile: AresProfile,
    startUrl?: string,
    cookieSnapshotId?: string
  ): Promise<SeleniumBaseProfileBrowserStatus> {
    const profileId = String(profile.id ?? "").trim();
    if (!profileId) throw new Error("Profil-ID fehlt.");

    const existing = this.sessions.get(profileId);
    if (existing && existing.child.exitCode == null) return this.status(profileId);

    const userDataDir = this.resolveUserDataDir(profileId);
    const workerScript = this.resolveWorkerScript();
    const pythonExecutable = process.env["ARES_PYTHON_EXECUTABLE"]?.trim() || "python";
    const child = spawn(pythonExecutable, [workerScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env }
    });

    const session: SeleniumBaseManualSession = {
      profileId,
      child,
      userDataDir,
      startedAt: new Date().toISOString(),
      appliedSnapshotId: String(cookieSnapshotId ?? "").trim() || undefined
    };
    this.sessions.set(profileId, session);
    child.once("exit", () => {
      if (this.sessions.get(profileId)?.child === child) this.sessions.delete(profileId);
      session.patchrightBrowser = undefined;
      session.patchrightContext = undefined;
      session.patchrightPage = undefined;
    });

    const snapshotId = String(cookieSnapshotId ?? "").trim();
    const cookies = snapshotId
      ? readRegisteredProfileCookieSnapshot(profileId, snapshotId)
      : undefined;
    if (snapshotId && !cookies) {
      this.sessions.delete(profileId);
      if (child.exitCode == null) child.kill("SIGTERM");
      throw new Error("Cookie-Snapshot konnte für SeleniumBase nicht geladen werden.");
    }

    const requestedStartUrl = startUrl?.trim() || "";
    const proxy = this.resolveProxy(profile);
    const bootstrapWithSeleniumBase = Boolean(requestedStartUrl && proxy?.username);
    const requestId = randomUUID();
    const payload = {
      type: "start",
      requestId,
      profileId,
      profileDir: userDataDir,
      startUrl: bootstrapWithSeleniumBase ? requestedStartUrl : undefined,
      proxy: this.toSeleniumBaseProxy(proxy),
      userAgent: profile.browser?.userAgent || undefined,
      cookies
    };

    try {
      const message = await this.waitForMessage(child, requestId, "ready", 30_000, true);

      if (requestedStartUrl) {
        if (bootstrapWithSeleniumBase) {
          await this.attachPatchright(profileId);
          const activeSession = this.requireOpenSession(profileId);
          const page = activeSession.patchrightPage;
          if (!page) throw new Error("Patchright-Page fehlt nach dem CDP-Attach.");
          await page.waitForTimeout(POST_NAVIGATION_CAPTCHA_DELAY_MS);
          await this.requestCaptchaAttempt(activeSession);
        } else {
          await this.navigateWithPatchright(profileId, requestedStartUrl);
        }
      }

      return {
        engine: "seleniumbase-cdp",
        profileId,
        open: true,
        pid: message.pid ?? child.pid,
        userDataDir: message.profileDir || userDataDir,
        startedAt: session.startedAt,
        appliedSnapshotId: session.appliedSnapshotId
      };
    } catch (error) {
      this.sessions.delete(profileId);
      if (child.exitCode == null) child.kill("SIGTERM");
      throw error;
    }
  }

  async attachPatchright(profileId: string): Promise<{ endpointUrl: string; url: string }> {
    const id = String(profileId ?? "").trim();
    const session = this.requireOpenSession(id);
    const existingPage = session.patchrightPage;
    if (session.patchrightBrowser?.isConnected() && existingPage && !existingPage.isClosed()) {
      return { endpointUrl: session.cdpEndpoint || "", url: existingPage.url() };
    }

    const requestId = randomUUID();
    session.child.stdin.write(`${JSON.stringify({ type: "get-cdp-endpoint", requestId })}\n`);
    const message = await this.waitForMessage(session.child, requestId, "cdp-endpoint", 10_000);
    const endpointUrl = String(message.endpointUrl ?? "").trim();
    if (!endpointUrl) throw new Error("SeleniumBase-CDP-Endpunkt fehlt.");

    const browser = await chromium.connectOverCDP(endpointUrl);
    const contexts = browser.contexts();
    if (!contexts.length) throw new Error("Patchright fand keinen SeleniumBase Browser-Context.");
    const context = contexts[0];
    const pages = context.pages();
    if (!pages.length) throw new Error("Patchright fand keine SeleniumBase Browser-Page.");
    const page = pages[0];

    session.cdpEndpoint = endpointUrl;
    session.patchrightBrowser = browser;
    session.patchrightContext = context;
    session.patchrightPage = page;
    browser.once("disconnected", () => {
      if (session.patchrightBrowser === browser) {
        session.patchrightBrowser = undefined;
        session.patchrightContext = undefined;
        session.patchrightPage = undefined;
      }
    });

    return { endpointUrl, url: page.url() };
  }

  async navigateWithPatchright(
    profileId: string,
    url: string
  ): Promise<SeleniumBasePatchrightNavigationResult> {
    const target = String(url ?? "").trim();
    if (!target) throw new Error("Navigation-URL fehlt.");

    const attached = await this.attachPatchright(profileId);
    const session = this.requireOpenSession(profileId);
    const page = session.patchrightPage;
    if (!page || page.isClosed()) throw new Error("Patchright-Page ist nicht verfügbar.");

    await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    await page.waitForTimeout(POST_NAVIGATION_CAPTCHA_DELAY_MS);
    await this.requestCaptchaAttempt(session);

    return {
      endpointUrl: attached.endpointUrl,
      url: page.url(),
      title: await page.title()
    };
  }

  async applySnapshot(profileId: string, snapshotId: string): Promise<{ count: number; snapshotId: string }> {
    const id = String(profileId ?? "").trim();
    const selected = String(snapshotId ?? "").trim();
    if (!selected) throw new Error("Cookie-Snapshot fehlt.");
    const session = this.requireOpenSession(id);
    const cookies = readRegisteredProfileCookieSnapshot(id, selected);
    if (!cookies) throw new Error("Cookie-Snapshot konnte für SeleniumBase nicht geladen werden.");

    const requestId = randomUUID();
    session.child.stdin.write(`${JSON.stringify({ type: "apply-cookies", requestId, cookies })}\n`);
    const message = await this.waitForMessage(session.child, requestId, "cookies-applied", 12_000);
    session.appliedSnapshotId = selected;
    return { count: Number(message.count ?? cookies.length), snapshotId: selected };
  }

  async captureCookies(profileId: string): Promise<ProfileCookieSnapshotCookie[]> {
    const id = String(profileId ?? "").trim();
    const session = this.requireOpenSession(id);
    const requestId = randomUUID();
    session.child.stdin.write(`${JSON.stringify({ type: "export-cookies", requestId })}\n`);
    const message = await this.waitForMessage(session.child, requestId, "cookies", 12_000);
    return Array.isArray(message.cookies) ? message.cookies : [];
  }

  async saveSnapshot(
    profileId: string,
    name: string,
    snapshotId?: string
  ): Promise<ProfileCookieSnapshotSummary> {
    const cookies = await this.captureCookies(profileId);
    return saveRegisteredProfileCookieSnapshot(profileId, name, cookies, snapshotId);
  }

  async close(profileId: string): Promise<SeleniumBaseProfileBrowserStatus> {
    const id = String(profileId ?? "").trim();
    const session = this.sessions.get(id);
    if (!session) return this.status(id);

    session.patchrightBrowser = undefined;
    session.patchrightContext = undefined;
    session.patchrightPage = undefined;
    session.cdpEndpoint = undefined;

    const child = session.child;
    if (child.exitCode == null) {
      const requestId = randomUUID();
      try {
        child.stdin.write(`${JSON.stringify({ type: "close", requestId })}\n`);
        await this.waitForMessage(child, requestId, "closed", 10_000);
      } catch {
        if (child.exitCode == null) child.kill("SIGTERM");
      }
      const graceful = await this.waitForExit(child, 4_000);
      if (!graceful && child.exitCode == null) child.kill("SIGKILL");
    }
    this.sessions.delete(id);
    return this.status(id);
  }

  status(profileId: string): SeleniumBaseProfileBrowserStatus {
    const id = String(profileId ?? "").trim();
    const session = this.sessions.get(id);
    const open = Boolean(session && session.child.exitCode == null);
    return {
      engine: "seleniumbase-cdp",
      profileId: id,
      open,
      pid: open ? session?.child.pid : undefined,
      userDataDir: this.resolveUserDataDir(id),
      startedAt: open ? session?.startedAt : undefined,
      appliedSnapshotId: open ? session?.appliedSnapshotId : undefined
    };
  }

  isOpen(profileId: string): boolean {
    return this.status(profileId).open;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map(profileId => this.close(profileId)));
  }

  private async requestCaptchaAttempt(session: SeleniumBaseManualSession): Promise<void> {
    const requestId = randomUUID();
    session.child.stdin.write(`${JSON.stringify({ type: "solve-captcha", requestId })}\n`);
    await this.waitForMessage(session.child, requestId, "captcha-attempted", 15_000);
  }

  private requireOpenSession(profileId: string): SeleniumBaseManualSession {
    const session = this.sessions.get(profileId);
    if (!session || session.child.exitCode != null) {
      throw new Error("SeleniumBase-CDP-Profilbrowser ist nicht geöffnet.");
    }
    return session;
  }

  private resolveUserDataDir(profileId: string): string {
    return path.join(resolveProfileUserDataDir(profileId, this.profileRoot), SELENIUMBASE_PROFILE_DIR);
  }

  private resolveWorkerScript(): string {
    const configured = process.env["ARES_SELENIUMBASE_MANUAL_WORKER"]?.trim();
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || "";
    const candidates = [
      configured,
      path.join(process.cwd(), "python", "seleniumbase_cdp", "manual_profile_browser.py"),
      path.join(__dirname, "../../python/seleniumbase_cdp/manual_profile_browser.py"),
      resourcesPath ? path.join(resourcesPath, "python", "seleniumbase_cdp", "manual_profile_browser.py") : undefined
    ].filter((value): value is string => Boolean(value));

    const worker = candidates.find(candidate => fs.existsSync(candidate));
    if (!worker) {
      throw new Error(
        "SeleniumBase-CDP-Worker wurde nicht gefunden. ARES_SELENIUMBASE_MANUAL_WORKER kann den Pfad explizit setzen."
      );
    }
    return worker;
  }

  private waitForMessage(
    child: ChildProcessWithoutNullStreams,
    requestId: string,
    expectedType: string,
    timeoutMs: number,
    includeStderr = false
  ): Promise<SeleniumBaseWireMessage> {
    return new Promise<SeleniumBaseWireMessage>((resolve, reject) => {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let settled = false;
      const timeout = setTimeout(() => finishError(new Error(`SeleniumBase ${expectedType} Timeout.`)), timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
      };
      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const finishSuccess = (message: SeleniumBaseWireMessage): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(message);
      };
      const onExit = (code: number | null): void => {
        const detail = includeStderr && stderrBuffer.trim() ? ` ${stderrBuffer.trim()}` : "";
        finishError(new Error(`SeleniumBase-Prozess wurde beendet (code=${String(code)}).${detail}`));
      };
      const onError = (error: Error): void => finishError(error);
      const onStderr = (chunk: unknown): void => {
        stderrBuffer = `${stderrBuffer}${String(chunk)}`.slice(-4_000);
      };
      const onStdout = (chunk: unknown): void => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith(WIRE_PREFIX)) continue;
          let message: SeleniumBaseWireMessage;
          try {
            message = JSON.parse(line.slice(WIRE_PREFIX.length)) as SeleniumBaseWireMessage;
          } catch {
            continue;
          }
          if (message.requestId && message.requestId !== requestId) continue;
          if (message.type === "error") {
            finishError(new Error(message.error || "SeleniumBase-CDP-Workerfehler."));
            return;
          }
          if (message.type === expectedType) {
            finishSuccess(message);
            return;
          }
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode != null) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeListener("exit", onExit);
        resolve(exited);
      };
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
      return {
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password
      };
    }
    if (!profile.proxy?.host || !profile.proxy.port) return undefined;
    return {
      protocol: profile.proxy.protocol || "http",
      host: profile.proxy.host,
      port: profile.proxy.port,
      username: profile.proxy.username || undefined,
      password: profile.proxy.password || undefined
    };
  }

  private toSeleniumBaseProxy(proxy?: BrowserProxyConfig): string | undefined {
    if (!proxy?.host || !proxy.port) return undefined;
    const auth = proxy.username
      ? `${proxy.username}:${proxy.password ?? ""}@`
      : "";
    const endpoint = `${auth}${proxy.host}:${proxy.port}`;
    return proxy.protocol && proxy.protocol !== "http"
      ? `${proxy.protocol}://${endpoint}`
      : endpoint;
  }
}
