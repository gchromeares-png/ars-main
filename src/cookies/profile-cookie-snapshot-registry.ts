import type { ProfileCookieSnapshotCookie, ProfileCookieSnapshotVault } from "./profile-cookie-snapshot-vault";

let registeredVault: ProfileCookieSnapshotVault | undefined;

export function registerProfileCookieSnapshotVault(vault: ProfileCookieSnapshotVault): void {
  registeredVault = vault;
}

export function readRegisteredProfileCookieSnapshot(
  profileId: string,
  snapshotId: string
): ProfileCookieSnapshotCookie[] | undefined {
  if (!registeredVault) return undefined;
  return registeredVault.read(profileId, snapshotId);
}

export function deleteRegisteredProfileCookieSnapshots(profileId: string): number {
  return registeredVault?.deleteProfile(profileId) ?? 0;
}
