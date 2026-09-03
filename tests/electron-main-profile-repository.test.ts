import * as fs from "fs";
import * as path from "path";

describe("Electron main profile repository wiring", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/electron/main.ts"),
    "utf8"
  );

  it("declares the profile repository outside the shops Map type", () => {
    expect(source).toContain("const shops = new Map<string, {");
    expect(source).toContain("}>();\nconst profileRepository = new ProfileRepository();");
    expect(source).not.toContain(
      "const shops = new Map<string, {\nconst profileRepository"
    );
  });
});
