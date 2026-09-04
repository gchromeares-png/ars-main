import { Injectable } from "@angular/core";

export interface ProfileBrowserStatusView {
  profileId: string;
  open: boolean;
  pid?: number;
  userDataDir?: string;
  startedAt?: string;
}

@Injectable({ providedIn: "root" })
export class ProfileBrowserService {
  private readonly previewOpen = new Set<string>();

  private get api(): Window["ares"] | undefined {
    return typeof window !== "undefined" ? window.ares : undefined;
  }

  getStatus(profileId: string): Promise<any> {
    if (this.api?.getProfileBrowserStatus) return this.api.getProfileBrowserStatus(profileId);
    return Promise.resolve({
      success: true,
      status: { profileId, open: this.previewOpen.has(profileId) }
    });
  }

  open(profileId: string, startUrl?: string): Promise<any> {
    if (this.api?.openProfileBrowser) return this.api.openProfileBrowser(profileId, startUrl);
    this.previewOpen.add(profileId);
    return Promise.resolve({
      success: true,
      status: { profileId, open: true, startedAt: new Date().toISOString() }
    });
  }

  close(profileId: string): Promise<any> {
    if (this.api?.closeProfileBrowser) return this.api.closeProfileBrowser(profileId);
    this.previewOpen.delete(profileId);
    return Promise.resolve({
      success: true,
      status: { profileId, open: false }
    });
  }
}
