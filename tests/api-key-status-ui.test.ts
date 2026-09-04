import * as fs from "fs";
import * as path from "path";
import { isCapMonsterApiKeyConfigured } from "../src/electron/capmonster-api-key-health";

const read = (relativePath: string): string => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("privacy-safe CapMonster API key status UI", () => {
  const originalKey = process.env["CAPMONSTER_API_KEY"];

  afterEach(() => {
    if (originalKey === undefined) delete process.env["CAPMONSTER_API_KEY"];
    else process.env["CAPMONSTER_API_KEY"] = originalKey;
  });

  test("placeholder and empty values are not treated as configured", () => {
    process.env["CAPMONSTER_API_KEY"] = "hier_deinen_echten_capmonster_key_eintragen";
    expect(isCapMonsterApiKeyConfigured()).toBe(false);

    process.env["CAPMONSTER_API_KEY"] = "";
    expect(isCapMonsterApiKeyConfigured()).toBe(false);

    process.env["CAPMONSTER_API_KEY"] = "real-test-key";
    expect(isCapMonsterApiKeyConfigured()).toBe(true);
  });

  test("Electron exposes only status/check results to the renderer", () => {
    const main = read("src/electron/main.ts");
    const preload = read("src/electron/preload.ts");
    const service = read("src/app/services/electron.service.ts");

    expect(main).toContain('ipcMain.handle("test-capmonster-api-key"');
    expect(main).toContain("loadCapMonsterApiKeyFromEnvFiles(app.getAppPath())");
    expect(main).toContain("captchaApiKeyConfigured: isCapMonsterApiKeyConfigured()");
    expect(preload).toContain("testCapmonsterApiKey");
    expect(service).toContain("testCapmonsterApiKey(): Promise<any>");
  });

  test("runtime UI shows configured state and checker without rendering key material", () => {
    const html = read("src/app/runtime-control/runtime-control.component.html");
    const component = read("src/app/runtime-control/runtime-control.component.ts");

    expect(html).toContain("API-KEY GESETZT");
    expect(html).toContain("API-KEY NICHT GESETZT");
    expect(html).toContain("KEY TESTEN");
    expect(html).toContain("Der API-Key wird niemals in der UI angezeigt");
    expect(component).toContain("apiKeyCheckLabel");
    expect(component).toContain("testCapmonsterApiKey");
    expect(html).not.toContain("CAPMONSTER_API_KEY");
  });
});
