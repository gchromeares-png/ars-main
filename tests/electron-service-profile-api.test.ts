import * as fs from "fs";
import * as path from "path";

describe("ElectronService profile API", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/app/services/electron.service.ts"),
    "utf8"
  );

  it("keeps Angular import first and profile methods inside the service class", () => {
    expect(source.trimStart().startsWith('import { Injectable } from "@angular/core";')).toBe(true);
    expect(source).toContain("export class ElectronService");
    expect(source).toContain("getProfiles(): Promise<any>");
    expect(source).toContain("saveProfile(profile: unknown): Promise<any>");
    expect(source).toContain("deleteProfile(profileId: string): Promise<any>");
  });
});
