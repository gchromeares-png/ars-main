import * as fs from "fs";
import * as path from "path";

describe("Electron main profile repository wiring", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/electron/main.ts"),
    "utf8"
  );

  it("declares the profile repository independently from the commerce shop registry", () => {
    const shopsDeclaration = "const shops = new Map<string, CommerceShop>();";
    const profileDeclaration = "const profileRepository = new ProfileRepository();";
    const shopsIndex = source.indexOf(shopsDeclaration);
    const profileIndex = source.indexOf(profileDeclaration);

    expect(shopsIndex).toBeGreaterThanOrEqual(0);
    expect(profileIndex).toBeGreaterThan(shopsIndex);
    expect(source.slice(shopsIndex, profileIndex + profileDeclaration.length)).toContain(profileDeclaration);
  });
});
