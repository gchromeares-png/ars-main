import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import {
  acquireBrowserProfileLease,
  inspectBrowserProfileLease,
  resolveProfileUserDataDir,
  safeProfilePartitionName
} from "../src/browser-worker/profile-session-manager";

describe("browser profile session manager", () => {
  it("creates stable profile-owned directory names", () => {
    expect(safeProfilePartitionName("Privat DE / 1")).toBe("profile_Privat_DE___1");
    expect(resolveProfileUserDataDir("abc-1", "C:/ares/browser-profiles").replace(/\\/g, "/"))
      .toContain("/browser-profiles/profile_abc-1");
  });

  it("allows only one live owner for the same profile directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ares-profile-lease-test-"));
    const userDataDir = path.join(root, "profile_test");
    const first = acquireBrowserProfileLease(userDataDir, "task:a");

    try {
      expect(inspectBrowserProfileLease(userDataDir)?.ownerId).toBe("task:a");
      expect(() => acquireBrowserProfileLease(userDataDir, "task:b")).toThrow(/currently active/i);
    } finally {
      first.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can reacquire a profile after the previous owner releases it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ares-profile-reacquire-test-"));
    const userDataDir = path.join(root, "profile_test");
    const first = acquireBrowserProfileLease(userDataDir, "task:a");
    first.release();

    const second = acquireBrowserProfileLease(userDataDir, "task:b");
    try {
      expect(inspectBrowserProfileLease(userDataDir)?.ownerId).toBe("task:b");
    } finally {
      second.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
