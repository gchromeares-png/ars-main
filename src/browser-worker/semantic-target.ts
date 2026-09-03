export type FieldIntent =
  | "email"
  | "firstName"
  | "lastName"
  | "fullName"
  | "street"
  | "address1"
  | "houseNumber"
  | "address2"
  | "city"
  | "postalCode"
  | "phone"
  | "countryCode"
  | "unknown";

export type AddressContext = "shipping" | "billing" | "unknown";

export interface SemanticTarget {
  intent: FieldIntent;
  context: AddressContext;
}

export type SemanticTargetKey = string & { readonly __semanticTargetKey: unique symbol };

export function semanticTarget(intent: FieldIntent, context: AddressContext = "unknown"): SemanticTarget {
  return { intent, context };
}

export function targetKey(target: SemanticTarget): SemanticTargetKey {
  return `${target.context}:${target.intent}` as SemanticTargetKey;
}

export function targetEquals(left: SemanticTarget, right: SemanticTarget): boolean {
  return left.intent === right.intent && left.context === right.context;
}
