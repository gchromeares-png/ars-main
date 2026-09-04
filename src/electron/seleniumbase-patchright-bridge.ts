import { chromium } from "patchright";
import type { Browser, BrowserContext, Page } from "patchright";
import { SeleniumBaseProfileBrowserController } from "./seleniumbase-profile-browser-controller";

interface SeleniumBasePatchrightSession {
  profileId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface SeleniumBasePatchrightStatus {
  profileId: string;
  attached: boolean;
  url: string;
  title: string;
}

export class SeleniumBasePatchrightBridge {
  private readonly sessions = new Map<string, SeleniumBasePatchrightSession>();

  constructor(private readonly seleniumBase: SeleniumBaseProfileBrowserController) {}

  async attach(profileId: string): Promise<SeleniumBasePatchrightStatus> {
    const id = String(profileId ?? "").trim();
    if (!id) throw new Error("Profil-ID fehlt.");

    const existing = this.sessions.get(id);
    if (existing?.browser.isConnected()) return this.inspect(existing);
    if (existing) this.sessions.delete(id);

    const endpointUrl = await this.seleniumBase.getCdpEndpoint(id);
    const browser = await chromium.connectOverCDP(endpointUrl);
    const contexts = browser.contexts();
    if (!contexts.length) {
      throw new Error("Patchright fand keinen bestehenden SeleniumBase Browser-Context.");
    }
    const context = contexts[0];
    const pages = context.pages();
    if (!pages.length) {
      throw new Error("Patchright fand keine bestehende SeleniumBase Browser-Page.");
    }
    const page = pages[0];

    const session: SeleniumBasePatchrightSession = { profileId: id, browser, context, page };
    this.sessions.set(id, session);
    browser.once("disconnected", () => {
      if (this.sessions.get(id)?.browser === browser) this.sessions.delete(id);
    });

    return this.inspect(session);
  }

  async navigateAndSolve(profileId: string, url: string): Promise<SeleniumBasePatchrightStatus> {
    const target = String(url ?? "").trim();
    if (!target) throw new Error("URL fehlt.");

    await this.attach(profileId);
    const session = this.requireAttached(profileId);

    await session.page.goto(target);
    await session.page.waitForTimeout(2_000);
    await this.seleniumBase.solveCaptcha(session.profileId);

    return this.inspect(session);
  }

  forget(profileId: string): void {
    this.sessions.delete(String(profileId ?? "").trim());
  }

  forgetAll(): void {
    this.sessions.clear();
  }

  private requireAttached(profileId: string): SeleniumBasePatchrightSession {
    const id = String(profileId ?? "").trim();
    const session = this.sessions.get(id);
    if (!session || !session.browser.isConnected()) {
      throw new Error("Patchright ist nicht an den SeleniumBase-Browser angehängt.");
    }
    return session;
  }

  private async inspect(session: SeleniumBasePatchrightSession): Promise<SeleniumBasePatchrightStatus> {
    return {
      profileId: session.profileId,
      attached: session.browser.isConnected(),
      url: session.page.url(),
      title: await session.page.title()
    };
  }
}
