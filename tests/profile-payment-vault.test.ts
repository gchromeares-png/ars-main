import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ProfilePaymentVault,
  type PaymentVaultCrypto
} from "../src/payments/profile-payment-vault";

function testCrypto(available = true): PaymentVaultCrypto {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`encrypted:${Buffer.from(value, "utf8").toString("base64")}`, "utf8"),
    decryptString: value => {
      const raw = value.toString("utf8");
      return Buffer.from(raw.replace(/^encrypted:/, ""), "base64").toString("utf8");
    }
  };
}

describe("ProfilePaymentVault", () => {
  let root: string;
  let filePath: string;
  const pan = Array.from({ length: 16 }, () => "4").join("");
  const cvc = ["1", "2", "3"].join("");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ares-payment-vault-"));
    filePath = path.join(root, "payment-vault.json");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("stores card secrets encrypted and returns only a masked renderer view", () => {
    const vault = new ProfilePaymentVault(filePath, testCrypto());
    const view = vault.save("profile-a", {
      cardholderName: "Test Holder",
      cardNumber: pan,
      expiryMonth: "7",
      expiryYear: "2030",
      cvc
    });

    expect(view.configured).toBe(true);
    expect(view.cardholderName).toBe("Test Holder");
    expect(view.maskedCardNumber).toMatch(/4444$/);
    expect(view.expiryMonth).toBe("07");
    expect(view.expiryYear).toBe("2030");
    expect(view.cvcStored).toBe(true);

    const onDisk = fs.readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain(pan);
    expect(onDisk).not.toContain("Test Holder");
    expect(onDisk).not.toContain(cvc);

    const session = vault.toCheckoutPaymentSession("profile-a", { method: "card" });
    expect(session.card?.cardholderName).toBe("Test Holder");
    expect(session.card?.cardNumber).toBe(pan);
    expect(session.card?.expiryMonth).toBe("07");
    expect(session.card?.expiryYear).toBe("2030");
    expect(session.card?.expiry).toBe("07/30");
    expect(session.card?.cvc).toBe(cvc);
  });

  test("preserves encrypted PAN and CVC when the UI resaves masked values", () => {
    const vault = new ProfilePaymentVault(filePath, testCrypto());
    const first = vault.save("profile-a", {
      cardholderName: "Test Holder",
      cardNumber: pan,
      expiryMonth: "07",
      expiryYear: "2030",
      cvc
    });

    vault.save("profile-a", {
      cardholderName: "Updated Holder",
      cardNumber: first.maskedCardNumber,
      expiryMonth: "08",
      expiryYear: "2031",
      cvc: ""
    });

    const session = vault.toCheckoutPaymentSession("profile-a", { method: "card" });
    expect(session.card?.cardNumber).toBe(pan);
    expect(session.card?.cvc).toBe(cvc);
    expect(session.card?.cardholderName).toBe("Updated Holder");
    expect(session.card?.expiry).toBe("08/31");
  });

  test("fails closed when OS encryption is unavailable", () => {
    const vault = new ProfilePaymentVault(filePath, testCrypto(false));
    expect(() => vault.save("profile-a", {
      cardholderName: "Test Holder",
      cardNumber: pan,
      expiryMonth: "07",
      expiryYear: "2030",
      cvc
    })).toThrow(/Verschlüsselung/);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
