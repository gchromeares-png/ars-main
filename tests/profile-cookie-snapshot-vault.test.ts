import { mkdtempSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import {
  ProfileCookieSnapshotVault,
  type CookieSnapshotCrypto,
  type ProfileCookieSnapshotCookie
} from "../src/cookies/profile-cookie-snapshot-vault";

class TestCrypto implements CookieSnapshotCrypto {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(`enc:${Buffer.from(value).toString("base64")}`); }
  decryptString(value: Buffer): string {
    const raw = value.toString();
    if (!raw.startsWith("enc:")) throw new Error("invalid ciphertext");
    return Buffer.from(raw.slice(4), "base64").toString();
  }
}

describe("ProfileCookieSnapshotVault", () => {
  let root = "";
  let storagePath = "";

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ares-cookie-vault-"));
    storagePath = path.join(root, "cookie-snapshots.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stores cookie payload encrypted and exposes metadata only in list", () => {
    const vault = new ProfileCookieSnapshotVault(storagePath, new TestCrypto());
    const cookie: ProfileCookieSnapshotCookie = {
      name: "session",
      value: "top-secret-cookie-value",
      domain: ".example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      partitionKey: "https://example.com"
    };

    const saved = vault.save("adam", "Pokemon Login", [cookie]);
    expect(saved.cookieCount).toBe(1);

    const rawFile = readFileSync(storagePath, "utf8");
    expect(rawFile).not.toContain("top-secret-cookie-value");
    expect(rawFile).not.toContain('"value"');

    const listed = vault.list("adam");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(saved);
    expect(listed[0]).not.toHaveProperty("ciphertext");

    expect(vault.read("adam", saved.id)).toEqual([cookie]);
  });

  it("keeps snapshots profile-owned and removes them with the profile", () => {
    const vault = new ProfileCookieSnapshotVault(storagePath, new TestCrypto());
    const cookie: ProfileCookieSnapshotCookie = {
      name: "auth",
      value: "kept",
      domain: "example.com",
      path: "/",
      expires: 1999999999,
      httpOnly: true,
      secure: true,
      sameSite: "Strict"
    };
    const saved = vault.save("adam", "Login", [cookie]);

    expect(() => vault.read("max", saved.id)).toThrow(/nicht gefunden/i);
    expect(vault.deleteProfile("adam")).toBe(1);
    expect(vault.list("adam")).toEqual([]);
  });
});
