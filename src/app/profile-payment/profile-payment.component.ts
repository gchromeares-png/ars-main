import { Component, Input, OnChanges, SimpleChanges } from "@angular/core";

interface PaymentView {
  configured: boolean;
  cardholderName?: string;
  maskedCardNumber?: string;
  expiryMonth?: string;
  expiryYear?: string;
  cvcStored?: boolean;
  updatedAt?: string;
}

@Component({
  selector: "app-profile-payment",
  templateUrl: "./profile-payment.component.html",
  styleUrls: ["./profile-payment.component.scss"]
})
export class ProfilePaymentComponent implements OnChanges {
  @Input() profileId = "";

  cardholderName = "";
  cardNumber = "";
  expiryMonth = "";
  expiryYear = "";
  cvc = "";

  configured = false;
  encryptionAvailable = true;
  saving = false;
  error = "";
  info = "";

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    if (changes["profileId"]) await this.load();
  }

  async save(): Promise<void> {
    this.error = "";
    this.info = "";
    const id = this.profileId.trim();
    if (!id) {
      this.error = "Bitte zuerst eine Profil-ID vergeben.";
      return;
    }

    const api = (window as any).ares;
    if (!api?.saveProfilePayment) {
      this.error = "Verschlüsselter Payment Vault ist nur in der Electron-App verfügbar.";
      return;
    }

    this.saving = true;
    try {
      const result = await api.saveProfilePayment(id, {
        cardholderName: this.cardholderName,
        cardNumber: this.cardNumber,
        expiryMonth: this.expiryMonth,
        expiryYear: this.expiryYear,
        cvc: this.cvc
      });
      this.encryptionAvailable = result.encryptionAvailable !== false;
      if (!result.success) {
        this.error = result.error || "Zahlungsdaten konnten nicht gespeichert werden.";
        return;
      }
      this.applyView(result.payment as PaymentView);
      this.cvc = "";
      this.info = "Zahlungsdaten verschlüsselt gespeichert.";
    } finally {
      this.saving = false;
    }
  }

  private async load(): Promise<void> {
    this.error = "";
    this.info = "";
    this.configured = false;
    this.cardholderName = "";
    this.cardNumber = "";
    this.expiryMonth = "";
    this.expiryYear = "";
    this.cvc = "";

    const id = this.profileId.trim();
    if (!id) return;
    const api = (window as any).ares;
    if (!api?.getProfilePayment) return;

    const result = await api.getProfilePayment(id);
    this.encryptionAvailable = result.encryptionAvailable !== false;
    if (!result.success) {
      this.error = result.error || "Gespeicherte Zahlungsdaten konnten nicht geladen werden.";
      return;
    }
    this.applyView(result.payment as PaymentView);
  }

  private applyView(payment?: PaymentView): void {
    if (!payment?.configured) {
      this.configured = false;
      return;
    }
    this.configured = true;
    this.cardholderName = payment.cardholderName || "";
    this.cardNumber = payment.maskedCardNumber || "";
    this.expiryMonth = payment.expiryMonth || "";
    this.expiryYear = payment.expiryYear || "";
  }
}
