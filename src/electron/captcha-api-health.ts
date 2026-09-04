import * as https from "https";

export type CaptchaApiCheckStatus = "missing" | "valid" | "invalid" | "unreachable";

export interface CaptchaApiCheckResult {
  success: boolean;
  provider: "CapMonster";
  configured: boolean;
  status: CaptchaApiCheckStatus;
  checkedAt: string;
  message: string;
  errorCode?: string;
}

interface CapMonsterBalanceResponse {
  errorId?: number;
  errorCode?: unknown;
  balance?: unknown;
}

function safeProviderErrorCode(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9_:-]{1,80}$/.test(normalized) ? normalized : undefined;
}

export function missingCaptchaApiKeyResult(checkedAt = new Date().toISOString()): CaptchaApiCheckResult {
  return {
    success: false,
    provider: "CapMonster",
    configured: false,
    status: "missing",
    checkedAt,
    message: "CAPMONSTER_API_KEY ist im ARES-Runtime-Environment nicht gesetzt."
  };
}

export function classifyCapMonsterBalanceResponse(
  response: CapMonsterBalanceResponse,
  checkedAt = new Date().toISOString()
): CaptchaApiCheckResult {
  if (Number(response?.errorId) === 0) {
    return {
      success: true,
      provider: "CapMonster",
      configured: true,
      status: "valid",
      checkedAt,
      message: "API-Key wurde von CapMonster bestätigt."
    };
  }

  const errorCode = safeProviderErrorCode(response?.errorCode);
  return {
    success: false,
    provider: "CapMonster",
    configured: true,
    status: "invalid",
    checkedAt,
    message: "CapMonster hat den API-Key nicht bestätigt.",
    ...(errorCode ? { errorCode } : {})
  };
}

function unreachableResult(message: string, checkedAt = new Date().toISOString()): CaptchaApiCheckResult {
  return {
    success: false,
    provider: "CapMonster",
    configured: true,
    status: "unreachable",
    checkedAt,
    message
  };
}

export async function checkCapMonsterApiKey(apiKey = process.env["CAPMONSTER_API_KEY"]): Promise<CaptchaApiCheckResult> {
  const key = String(apiKey ?? "").trim();
  const checkedAt = new Date().toISOString();
  if (!key) return missingCaptchaApiKeyResult(checkedAt);

  const payload = JSON.stringify({ clientKey: key });

  return new Promise(resolve => {
    let settled = false;
    const finish = (result: CaptchaApiCheckResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = https.request({
      protocol: "https:",
      hostname: "api.capmonster.cloud",
      port: 443,
      path: "/getBalance",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "user-agent": "ARES/1.0 api-health-check"
      }
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        if (body.length < 16_384) body += String(chunk).slice(0, 16_384 - body.length);
      });
      response.on("end", () => {
        const statusCode = Number(response.statusCode ?? 0);
        if (statusCode < 200 || statusCode >= 300) {
          finish(unreachableResult(`CapMonster API antwortete mit HTTP ${statusCode || "unbekannt"}.`, checkedAt));
          return;
        }

        try {
          const parsed = JSON.parse(body) as CapMonsterBalanceResponse;
          finish(classifyCapMonsterBalanceResponse(parsed, checkedAt));
        } catch {
          finish(unreachableResult("CapMonster API lieferte keine verwertbare Antwort.", checkedAt));
        }
      });
    });

    request.setTimeout(7_000, () => request.destroy(new Error("ARES_CAPMONSTER_CHECK_TIMEOUT")));
    request.on("error", error => {
      const timedOut = error instanceof Error && error.message === "ARES_CAPMONSTER_CHECK_TIMEOUT";
      finish(unreachableResult(
        timedOut ? "CapMonster API-Check hat nach 7 Sekunden ein Timeout erreicht." : "CapMonster API ist für den Check nicht erreichbar.",
        checkedAt
      ));
    });

    request.write(payload);
    request.end();
  });
}
