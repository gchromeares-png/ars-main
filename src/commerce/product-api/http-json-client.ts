import * as http from "http";
import * as https from "https";
import type { JsonHttpClient, JsonHttpResponse } from "./types";

export class NodeJsonHttpClient implements JsonHttpClient {
  constructor(
    private readonly timeoutMs = 12_000,
    private readonly userAgent = "ARES-Product-Monitor/1.0"
  ) {}

  get<T>(url: string, headers: Record<string, string> = {}): Promise<JsonHttpResponse<T>> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === "http:" ? http : https;
      const request = transport.request(target, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": this.userAgent,
          ...headers
        }
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === "string") responseHeaders[key] = value;
            else if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
          }

          let data: T | undefined;
          if (text.trim()) {
            try {
              data = JSON.parse(text) as T;
            } catch {
              data = undefined;
            }
          }

          resolve({
            status: response.statusCode ?? 0,
            headers: responseHeaders,
            data,
            text: data === undefined ? text.slice(0, 1_000) : undefined
          });
        });
      });

      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error(`HTTP timeout after ${this.timeoutMs}ms`));
      });
      request.on("error", reject);
      request.end();
    });
  }
}
