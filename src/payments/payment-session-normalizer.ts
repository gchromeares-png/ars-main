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

function combinedExpiry(card: Record<string, unknown>): string | undefined {
  const direct = text(card["expiry"], 12);
  if (direct) return direct;

  const month = text(card["expiryMonth"], 4)?.replace(/\D/g, "");
  const year = text(card["expiryYear"], 6)?.replace(/\D/g, "");
  if (!month || !year) return undefined;
  return `${month.padStart(2, "0")}/${year.slice(-2)}`;
}

/**
 * Compatibility boundary for renderer/profile payloads.
 * The established checkout runtime contract remains holderName/securityCode.
 * UI/vault aliases such as cardholderName/cvc are translated only here.
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
    holderName: text(card["holderName"], 120) ?? text(card["cardholderName"], 120),
    cardNumber: compactDigits(card["cardNumber"], 24),
    expiry: combinedExpiry(card),
    securityCode: text(card["securityCode"], 8) ?? text(card["cvc"], 8) ?? text(card["cvv"], 8)
  };

  return session;
}
