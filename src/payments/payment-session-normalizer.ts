import type { CheckoutPaymentSession, PaymentMethod } from "./models";

const ALLOWED_METHODS = new Set<PaymentMethod>(["card", "paypal", "shop-pay", "klarna", "other"]);

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || undefined;
}

function compactDigits(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, "").slice(0, maxLength);
  return normalized || undefined;
}

/**
 * Compatibility boundary for renderer/legacy task-session payloads.
 * Legacy aliases are accepted only here and are immediately rewritten to the
 * canonical AutoFill names used everywhere else in the runtime.
 */
export function normalizePaymentSessionInput(input: unknown): CheckoutPaymentSession | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const method = String(raw["method"] ?? "").trim() as PaymentMethod;
  if (!ALLOWED_METHODS.has(method)) return undefined;

  const session: CheckoutPaymentSession = {
    method,
    label: text(raw["label"], 120)
  };

  if (method !== "card") return session;

  const rawCard = raw["card"];
  if (!rawCard || typeof rawCard !== "object") return session;
  const card = rawCard as Record<string, unknown>;

  session.card = {
    cardholderName: text(card["cardholderName"], 120) ?? text(card["holderName"], 120),
    cardNumber: compactDigits(card["cardNumber"], 24),
    expiryMonth: text(card["expiryMonth"], 4),
    expiryYear: text(card["expiryYear"], 6),
    expiry: text(card["expiry"], 12),
    cvc: text(card["cvc"], 8) ?? text(card["securityCode"], 8)
  };

  return session;
}
