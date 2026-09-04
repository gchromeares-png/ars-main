import * as fs from "fs";
import * as path from "path";
import {
  classifyCapMonsterBalanceResponse,
  missingCaptchaApiKeyResult
} from "../src/electron/captcha-api-health";

describe("CapMonster API health privacy", () => {
  test("reports a missing key without exposing secret material", () => {
    const result = missingCaptchaApiKeyResult("2026-09-04T00:00:00.000Z");

    expect(result.configured).toBe(false);
    expect(result.status).toBe("missing");
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("clientKey");
    expect(result).not.toHaveProperty("keyPrefix");
    expect(result).not.toHaveProperty("keyHash");
  });

  test("maps a successful provider response to valid without returning balance", () => {
    const result = classifyCapMonsterBalanceResponse(
      { errorId: 0, balance: 123.45 },
      "2026-09-04T00:00:00.000Z"
    );

    expect(result.success).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.status).toBe("valid");
    expect(result).not.toHaveProperty("balance");
    expect(result).not.toHaveProperty("apiKey");
  });

  test("returns only a sanitized provider error code for rejected credentials", () => {
    const result = classifyCapMonsterBalanceResponse({
      errorId: 1,
      errorCode: "ERROR_KEY_DOES_NOT_EXIST"
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("invalid");
    expect(result.errorCode).toBe("ERROR_KEY_DOES_NOT_EXIST");
    expect(result).not.toHaveProperty("apiKey");
  });

  test("wires a read-only TEST control into the runtime UI", () => {
    const root = path.resolve(__dirname, "..");
    const preload = fs.readFileSync(path.join(root, "src/electron/preload.ts"), "utf8");
    const service = fs.readFileSync(path.join(root, "src/app/services/electron.service.ts"), "utf8");
    const runtime = fs.readFileSync(path.join(root, "src/app/runtime-control/runtime-control.component.ts"), "utf8");
    const html = fs.readFileSync(path.join(root, "src/app/runtime-control/runtime-control.component.html"), "utf8");

    expect(preload).toContain("checkCapMonsterApiKey");
    expect(preload).toContain("checkCaptchaApiKey");
    expect(service).toContain("checkCaptchaApiKey(): Promise<any>");
    expect(runtime).toContain("async checkCaptchaApiKey()");
    expect(html).toContain("CapMonster API");
    expect(html).toContain("API-KEY");
    expect(html).toContain("GESETZT");
    expect(html).toContain("FEHLT");
    expect(html).toContain("niemals den API-Key");
    expect(html).toContain("'TEST'");
  });
});
