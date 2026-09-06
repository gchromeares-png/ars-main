import { Component, Input } from "@angular/core";
import { ElectronService } from "../services/electron.service";

@Component({
  selector: "app-monitor-runtime-preload",
  template: `
    <div class="runtime-preload">
      <button
        type="button"
        class="runtime-preload__button"
        [disabled]="busy || !shopId"
        [title]="buttonTitle"
        (click)="prepare()"
      >{{ busy ? '…' : ready ? '✓' : '⚡' }}</button>
      <span *ngIf="ready" class="runtime-preload__state">Runtime ready</span>
      <span *ngIf="error" class="runtime-preload__error">{{ error }}</span>
    </div>
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; min-height: 30px; }
    .runtime-preload { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
    .runtime-preload__button {
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid #2b2d34;
      border-radius: 7px;
      background: #111318;
      color: #d9dcff;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }
    .runtime-preload__button:hover:not(:disabled) { border-color: #4f46e5; color: #ffffff; }
    .runtime-preload__button:disabled { opacity: .45; cursor: default; }
    .runtime-preload__state, .runtime-preload__error { font-size: 11px; white-space: nowrap; }
    .runtime-preload__state { color: #a7f3d0; }
    .runtime-preload__error { color: #fca5a5; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  `]
})
export class MonitorRuntimePreloadComponent {
  @Input() shopId = "";
  @Input() profileId = "";

  busy = false;
  ready = false;
  error = "";

  constructor(private readonly electron: ElectronService) {}

  get buttonTitle(): string {
    if (this.busy) return "Monitor-Runtime wird vorbereitet";
    if (this.ready) return "SeleniumBase + Vision Runtime ist vorgeladen";
    return "SeleniumBase + Vision Runtime für den Monitor vorladen";
  }

  async prepare(): Promise<void> {
    if (this.busy) return;
    this.error = "";
    this.ready = false;

    const profileId = String(this.profileId ?? "").trim();
    const shopId = String(this.shopId ?? "").trim();
    if (!profileId) {
      this.error = "Profil wählen";
      return;
    }
    if (!shopId) {
      this.error = "Shop wählen";
      return;
    }

    this.busy = true;
    try {
      const shopsResult = await this.electron.getShops();
      const shop = Array.isArray(shopsResult?.shops)
        ? shopsResult.shops.find((item: any) => String(item?.id ?? "") === shopId)
        : undefined;
      const startUrl = String(shop?.baseUrl ?? "").trim();
      if (!startUrl) throw new Error(`Shop ${shopId} wurde nicht gefunden.`);

      const vision = await this.electron.prepareSeleniumBaseVision();
      if (!vision?.success || !vision?.status?.ready) {
        throw new Error(vision?.error || vision?.status?.error || "Vision Runtime konnte nicht vorbereitet werden.");
      }

      const browser = await this.electron.openProfileBrowser(profileId, startUrl);
      if (!browser?.success || !browser?.status?.open) {
        throw new Error(browser?.error || "SeleniumBase Monitor-Runtime konnte nicht gestartet werden.");
      }

      this.ready = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
}
