import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  acquireBrowserProfileLease,
  removeProfileUserDataDir,
  resolveProfileUserDataDir
} from "../src/browser-worker/profile-session-manager";
import { clearProfileBrowserUserAgent } from "../src/profiles/profile-browser-reset";
import type { AresProfile } from "../src/profiles/models";

describe("profile browser session reset", () => {
  it("removes the entire persisted browser partition", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ares-reset-test-"));
    try {
      const profileId = "reset-profile";
      const userDataDir = resolveProfileUserDataDir(profileId, root);
      const persistedPaths = [
        ".ares-seleniumbase-cdp/Default/Cookies",
        ".ares-seleniumbase-cdp/Default/Local Storage/state.db",
        ".ares-seleniumbase-cdp/Default/IndexedDB/data.db",
        ".ares-seleniumbase-cdp/Default/Service Worker/cache.bin",
        ".ares-seleniumbase-cdp/Default/Cache/cache.bin",
        "task-runtime/session.json"
      ];
      for (const relative of persistedPaths) {
        const target = path.join(userDataDir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "persisted", "utf8");
      }

      expect(fs.existsSync(userDataDir)).toBe(true);
      removeProfileUserDataDir(profileId, root);
      expect(fs.existsSync(userDataDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses destructive deletion while a live profile lease exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ares-reset-lock-test-"));
    const profileId = "locked-profile";
    const userDataDir = resolveProfileUserDataDir(profileId, root);
    const lease = acquireBrowserProfileLease(userDataDir, "live-task");
    try {
      expect(() => removeProfileUserDataDir(profileId, root)).toThrow();
      expect(fs.existsSync(userDataDir)).toBe(true);
    } finally {
      lease.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears only the stored browser user-agent from ARES profile data", () => {
    const profile: AresProfile = {
      id: "profile-1",
      name: "Profile 1",
      contact: { firstName: "A", lastName: "B", email: "a@example.test" },
      address: { address1: "Test 1", postalCode: "20095", city: "Hamburg", countryCode: "DE" },
      preferredProxyId: "proxy-1",
      browser: { headless: false, userAgent: "ARES-UA", kiAutofill: true },
      paymentPreference: { method: "card", label: "Primary" }
    };

    const reset = clearProfileBrowserUserAgent(profile);
    expect(reset.browser?.userAgent).toBeUndefined();
    expect(reset.browser?.headless).toBe(false);
    expect(reset.browser?.kiAutofill).toBe(true);
    expect(reset.address).toEqual(profile.address);
    expect(reset.preferredProxyId).toBe("proxy-1");
    expect(reset.paymentPreference).toEqual(profile.paymentPreference);
    expect(profile.browser?.userAgent).toBe("ARES-UA");
  });
});
