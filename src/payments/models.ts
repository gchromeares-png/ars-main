export type PaymentMethod = "card" | "paypal" | "shop-pay" | "klarna" | "other";

export interface StoredPaymentPreference {
  method?: PaymentMethod;
  label?: string;
}

export interface CardPaymentSession {
  /** Canonical AutoFill field names. Legacy aliases are normalized at the IPC boundary. */
  cardholderName?: string;
  cardNumber?: string;
  expiryMonth?: string;
  expiryYear?: string;
  expiry?: string;
  cvc?: string;
}

/**
 * Sensitive checkout data for one running task only.
 * This object must never be persisted to profiles.json or SQLite.
 */
export interface CheckoutPaymentSession {
  method: PaymentMethod;
  label?: string;
  card?: CardPaymentSession;
}

export interface PaymentPreparationResult {
  detectedMethods: PaymentMethod[];
  selectedMethod?: PaymentMethod;
  filledFields: string[];
  missingFields: string[];
  requiresUserAction: boolean;
  note?: string;
}
