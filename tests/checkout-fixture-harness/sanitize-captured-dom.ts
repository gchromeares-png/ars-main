const JWT_PATTERN = /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_SECRET_PATTERN = /\b(?:[A-F0-9]{32,}|[A-Za-z0-9_-]{40,})\b/gi;

export interface CapturedDomSanitizeOptions {
  redactValues?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Conservative sanitizer for persisted real-DOM snapshots.
 * It deliberately removes executable/network-bearing markup and common token/
 * PII carriers while preserving the checkout form structure used by the tests.
 */
export function sanitizeCapturedDom(
  rawHtml: string,
  options: CapturedDomSanitizeOptions = {}
): string {
  let html = rawHtml;

  // Captured fixtures are static DOM references. Executable content and remote
  // resource loading are never required for replay and may contain secrets.
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "");
  html = html.replace(/<input\b[^>]*type\s*=\s*["']?hidden["']?[^>]*>/gi, "");
  html = html.replace(/<meta\b[^>]*>/gi, "");

  // Strip browser/session/network material while keeping DOM identity attributes.
  html = html.replace(/\s(?:href|src|action|formaction)\s*=\s*(["'])[^"']*\1/gi, "");
  html = html.replace(/\s(?:nonce|integrity|crossorigin)\s*=\s*(["'])[^"']*\1/gi, "");
  html = html.replace(/\s(?:data-[\w:-]*(?:token|session|auth|csrf)[\w:-]*)\s*=\s*(["'])[^"']*\1/gi, "");

  // User-entered input values are not needed to test field recognition/filling.
  html = html.replace(/(<input\b[^>]*?)\svalue\s*=\s*(["'])[^"']*\2/gi, "$1");
  html = html.replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea\s*>)/gi, "$1$2");

  // High-signal secret/PII patterns.
  html = html.replace(JWT_PATTERN, "[REDACTED_TOKEN]");
  html = html.replace(BEARER_PATTERN, "Bearer [REDACTED_TOKEN]");
  html = html.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  html = html.replace(LONG_SECRET_PATTERN, "[REDACTED_SECRET]");

  for (const rawValue of options.redactValues ?? []) {
    const value = rawValue.trim();
    if (!value) continue;
    html = html.replace(new RegExp(escapeRegExp(value), "gi"), "[REDACTED]");
  }

  return html;
}

export function assertSanitizedCapturedDom(html: string): void {
  const violations: string[] = [];
  if (/<script\b/i.test(html)) violations.push("script");
  if (/<input\b[^>]*type\s*=\s*["']?hidden/i.test(html)) violations.push("hidden-input");
  if (JWT_PATTERN.test(html)) violations.push("jwt");
  JWT_PATTERN.lastIndex = 0;
  if (BEARER_PATTERN.test(html)) violations.push("bearer-token");
  BEARER_PATTERN.lastIndex = 0;
  if (EMAIL_PATTERN.test(html)) violations.push("email");
  EMAIL_PATTERN.lastIndex = 0;
  if (/\b(?:csrf|xsrf|auth|session)[-_a-z0-9]*\s*=\s*["'][^"']+/i.test(html)) violations.push("token-attribute");

  if (violations.length) {
    throw new Error(`Captured DOM fixture is not sanitized: ${violations.join(", ")}`);
  }
}
