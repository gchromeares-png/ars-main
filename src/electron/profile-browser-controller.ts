import { ipcMain } from "electron";
import * as path from "path";
import type { AresProfile } from "../profiles/models";
import type { AresProxy } from "../proxies/models";
import type { ProfileCookieSnapshotCookie } from "../cookies/profile-cookie-snapshot-vault";
import { registerProfilePaymentIpc } from "./profile-payment-controller";
import { registerProfileCookieSnapshotIpc } from "./profile-cookie-snapshot-controller";
import {
  SeleniumBaseProfileBrowserController,
  type SeleniumBaseProfileBrowserStatus
} from "./seleniumbase-profile-browser-controller";
import { SeleniumBaseVisionRuntime } from "./seleniumbase-vision-runtime";

export type ProfileBrowserStatus = SeleniumBaseProfileBrowserStatus;

export interface ProfileBrowserOpenOptions {
  engine?: "seleniumbase-cdp";
  startUrl?: string;
  cookieSnapshotId?: string;
}

export class ProfileBrowserController {
  private readonly seleniumBase: SeleniumBaseProfileBrowserController;
  private readonly visionRuntime = new SeleniumBaseVisionRuntime();

  constructor(
    profileRoot: string,
    getProxy: (proxyId: string) => AresProxy | undefined
  ) {
    const userDataRoot = path.dirname(profileRoot);
    registerProfilePaymentIpc(userDataRoot);
    registerProfileCookieSnapshotIpc(userDataRoot, this);
    this.seleniumBase = new SeleniumBaseProfileBrowserController(profileRoot, getProxy);
    this.registerSeleniumBaseIpc();
  }

  async open(
    profile: AresProfile,
    startUrlOrOptions?: string | ProfileBrowserOpenOptions
  ): Promise<ProfileBrowserStatus> {
    const options = typeof startUrlOrOptions === "string"
      ? { startUrl: startUrlOrOptions }
      : (startUrlOrOptions ?? {});
    const vision = await this.visionRuntime.prepare();
    if (!vision.ready) {
      throw new Error(`ARES Vision Runtime ist nicht bereit: ${vision.error || "unbekannter Fehler"}`);
    }
    return this.seleniumBase.open(profile, options.startUrl, options.cookieSnapshotId);
  }

  captureCookies(profileId: string): Promise<ProfileCookieSnapshotCookie[]> {
    return this.seleniumBase.captureCookies(profileId);
  }

  close(profileId: string): Promise<ProfileBrowserStatus> {
    return this.seleniumBase.close(profileId);
  }

  status(profileId: string): ProfileBrowserStatus {
    return this.seleniumBase.status(profileId);
  }

  isOpen(profileId: string): boolean {
    return this.seleniumBase.isOpen(profileId);
  }

  closeAll(): Promise<void> {
    return this.seleniumBase.closeAll();
  }

  private registerSeleniumBaseIpc(): void {
    ipcMain.handle("get-seleniumbase-profile-browser-status", (_event, profileId: string) => {
      try {
        return { success: true, status: this.seleniumBase.status(profileId) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("get-seleniumbase-vision-status", async () => {
      try {
        return { success: true, status: await this.visionRuntime.status() };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("prepare-seleniumbase-vision", async () => {
      try {
        return { success: true, status: await this.visionRuntime.prepare() };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("close-seleniumbase-profile-browser", async (_event, profileId: string) => {
      try {
        return { success: true, status: await this.seleniumBase.close(profileId) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("apply-seleniumbase-cookie-snapshot", async (_event, profileId: string, snapshotId: string) => {
      try {
        return { success: true, ...(await this.seleniumBase.applySnapshot(profileId, snapshotId)) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("save-seleniumbase-profile-cookie-snapshot", async (
      _event,
      profileId: string,
      name: string,
      snapshotId?: string
    ) => {
      try {
        const snapshot = await this.seleniumBase.saveSnapshot(profileId, name, snapshotId);
        return { success: true, snapshot };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }
}
