import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from "@angular/core";
import { ProfileBrowserService } from "../services/profile-browser.service";
import {
  ProfileCookieSnapshotService,
  type CookieSnapshotView
} from "../services/profile-cookie-snapshot.service";

@Component({
  selector: "app-profile-cookie-snapshots",
  templateUrl: "./profile-cookie-snapshots.component.html",
  styleUrls: ["./profile-cookie-snapshots.component.scss"]
})
export class ProfileCookieSnapshotsComponent implements OnChanges {
  @Input() profileId = "";
  @Input() mode: "manage" | "select" = "manage";
  @Input() selectedId = "";
  @Output() selectedIdChange = new EventEmitter<string>();

  snapshots: CookieSnapshotView[] = [];
  snapshotName = "";
  browserOpen = false;
  busy = false;
  error = "";
  info = "";

  constructor(
    private readonly snapshotsApi: ProfileCookieSnapshotService,
    private readonly browserApi: ProfileBrowserService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["profileId"]) void this.refresh();
  }

  async refresh(): Promise<void> {
    this.error = "";
    if (!this.profileId) {
      this.snapshots = [];
      this.browserOpen = false;
      if (this.selectedId) this.select("");
      return;
    }

    const [snapshotsResult, browserResult] = await Promise.all([
      this.snapshotsApi.list(this.profileId),
      this.browserApi.getStatus(this.profileId)
    ]);
    this.snapshots = snapshotsResult?.success && Array.isArray(snapshotsResult.snapshots)
      ? snapshotsResult.snapshots
      : [];
    this.browserOpen = Boolean(browserResult?.success && browserResult.status?.open);
    if (this.selectedId && !this.snapshots.some(item => item.id === this.selectedId)) this.select("");
  }

  async openBrowser(): Promise<void> {
    if (!this.profileId || this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const result = await this.browserApi.open(this.profileId);
      if (!result?.success) this.error = result?.error || "Profil-Browser konnte nicht geöffnet werden.";
      else {
        this.browserOpen = true;
        this.info = "Profil-Browser geöffnet. Einloggen/navigieren und danach Snapshot speichern.";
      }
    } finally {
      this.busy = false;
    }
  }

  async closeBrowser(): Promise<void> {
    if (!this.profileId || this.busy) return;
    this.busy = true;
    try {
      const result = await this.browserApi.close(this.profileId);
      if (!result?.success) this.error = result?.error || "Profil-Browser konnte nicht geschlossen werden.";
      else this.browserOpen = false;
    } finally {
      this.busy = false;
    }
  }

  async saveSnapshot(): Promise<void> {
    const name = this.snapshotName.trim();
    if (!this.profileId || !name || this.busy) {
      if (!name) this.error = "Bitte einen Snapshot-Namen eingeben.";
      return;
    }
    if (!this.browserOpen) {
      this.error = "Profil-Browser zuerst öffnen. Gespeichert werden nur die Cookies der aktuell geöffneten Profil-Session.";
      return;
    }

    this.busy = true;
    this.error = "";
    try {
      const result = await this.snapshotsApi.save(this.profileId, name);
      if (!result?.success) {
        this.error = result?.error || "Cookie-Snapshot konnte nicht gespeichert werden.";
        return;
      }
      this.snapshotName = "";
      this.info = `${result.snapshot?.cookieCount ?? 0} Cookies verschlüsselt gespeichert.`;
      await this.refresh();
      if (result.snapshot?.id) this.select(result.snapshot.id);
    } finally {
      this.busy = false;
    }
  }

  async deleteSnapshot(snapshot: CookieSnapshotView): Promise<void> {
    if (!this.profileId || this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const result = await this.snapshotsApi.delete(this.profileId, snapshot.id);
      if (!result?.success) this.error = result?.error || "Snapshot konnte nicht gelöscht werden.";
      else {
        if (this.selectedId === snapshot.id) this.select("");
        await this.refresh();
      }
    } finally {
      this.busy = false;
    }
  }

  select(id: string): void {
    this.selectedId = id;
    this.selectedIdChange.emit(id);
  }

  formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("de-DE");
  }
}
