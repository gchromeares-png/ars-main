import { ipcMain, safeStorage } from "electron";
import * as path from "path";
import {
  ProfilePaymentVault,
  type PaymentVaultCrypto,
  type ProfilePaymentCardDraft
} from "../payments/profile-payment-vault";

let registered = false;

function electronVaultCrypto(): PaymentVaultCrypto {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: value => safeStorage.encryptString(value),
    decryptString: value => safeStorage.decryptString(value)
  };
}

/** Register renderer-safe payment-vault IPC once for the running Electron app. */
export function registerProfilePaymentIpc(userDataRoot: string): void {
  if (registered) return;
  registered = true;

  const vault = new ProfilePaymentVault(
    path.join(userDataRoot, "payment-vault.json"),
    electronVaultCrypto()
  );

  ipcMain.handle("get-profile-payment", (_event, profileId: string) => {
    try {
      return {
        success: true,
        payment: vault.getView(profileId),
        encryptionAvailable: vault.isEncryptionAvailable()
      };
    } catch (error) {
      return {
        success: false,
        payment: { configured: false },
        encryptionAvailable: vault.isEncryptionAvailable(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("save-profile-payment", (_event, profileId: string, input: ProfilePaymentCardDraft) => {
    try {
      const payment = vault.save(profileId, input ?? {});
      return {
        success: true,
        payment,
        encryptionAvailable: vault.isEncryptionAvailable()
      };
    } catch (error) {
      return {
        success: false,
        encryptionAvailable: vault.isEncryptionAvailable(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("delete-profile-payment", (_event, profileId: string) => {
    try {
      vault.delete(profileId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
