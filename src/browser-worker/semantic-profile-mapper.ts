import type { AddressProfile, AresProfile, ContactProfile } from "../profiles/models";
import { SemanticTargetValueMap, type SemanticTargetValue } from "./semantic-field-autofill";
import { semanticTarget, type AddressContext, type FieldIntent, type SemanticTarget } from "./semantic-target";

export type BillingAddressStrategy =
  | "explicit-billing"
  | "same-as-shipping-preferred"
  | "shipping-values-fallback";

export interface SemanticProfileMapping {
  values: SemanticTargetValueMap;
  billingStrategy: BillingAddressStrategy;
  hasExplicitBillingAddress: boolean;
  preferBillingSameAsShippingControl: boolean;
  valueFor(target: SemanticTarget): string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function joinName(contact: ContactProfile): string | undefined {
  return nonEmpty([contact.firstName, contact.lastName].map(value => value.trim()).filter(Boolean).join(" "));
}

function combinedAddress(address: AddressProfile): string | undefined {
  const address1 = nonEmpty(address.address1);
  if (address1) return address1;
  const street = nonEmpty(address.street);
  const houseNumber = nonEmpty(address.houseNumber);
  return nonEmpty([street, houseNumber].filter(Boolean).join(" "));
}

function addressValue(address: AddressProfile, intent: FieldIntent): string | undefined {
  switch (intent) {
    case "street": return nonEmpty(address.street);
    case "houseNumber": return nonEmpty(address.houseNumber);
    case "address1": return combinedAddress(address);
    case "address2": return nonEmpty(address.address2);
    case "city": return nonEmpty(address.city);
    case "postalCode": return nonEmpty(address.postalCode);
    case "countryCode": return nonEmpty(address.countryCode)?.toUpperCase();
    default: return undefined;
  }
}

function contactValue(contact: ContactProfile, intent: FieldIntent): string | undefined {
  switch (intent) {
    case "firstName": return nonEmpty(contact.firstName);
    case "lastName": return nonEmpty(contact.lastName);
    case "fullName": return joinName(contact);
    case "email": return nonEmpty(contact.email);
    case "phone": return nonEmpty(contact.phone);
    default: return undefined;
  }
}

function addressesEquivalent(left: AddressProfile, right: AddressProfile): boolean {
  const intents: FieldIntent[] = ["street", "houseNumber", "address1", "address2", "city", "postalCode", "countryCode"];
  return intents.every(intent => (addressValue(left, intent) ?? "").toLocaleUpperCase("de-DE") === (addressValue(right, intent) ?? "").toLocaleUpperCase("de-DE"));
}

function addTarget(entries: SemanticTargetValue[], intent: FieldIntent, context: AddressContext, value: string | undefined): void {
  const normalized = nonEmpty(value);
  if (!normalized || intent === "unknown") return;
  entries.push({ target: semanticTarget(intent, context), value: normalized });
}

export class SemanticProfileMapper {
  map(profile: AresProfile): SemanticProfileMapping {
    const shipping = profile.shippingAddress ?? profile.address;
    const explicitBilling = profile.billingAddress;
    const billing = explicitBilling ?? shipping;
    const billingStrategy: BillingAddressStrategy = explicitBilling
      ? "explicit-billing"
      : "same-as-shipping-preferred";

    const entries: SemanticTargetValue[] = [];
    const contactIntents: FieldIntent[] = ["firstName", "lastName", "fullName", "email", "phone"];
    const addressIntents: FieldIntent[] = ["street", "houseNumber", "address1", "address2", "city", "postalCode", "countryCode"];

    for (const intent of contactIntents) {
      const value = contactValue(profile.contact, intent);
      addTarget(entries, intent, "shipping", value);
      addTarget(entries, intent, "billing", value);
      addTarget(entries, intent, "unknown", value);
    }

    for (const intent of addressIntents) {
      addTarget(entries, intent, "shipping", addressValue(shipping, intent));
      addTarget(entries, intent, "billing", addressValue(billing, intent));

      // Unknown-context fields can safely use the default value only when there is
      // no semantic disagreement between shipping and billing. If addresses differ,
      // abstain rather than guessing which address a generic field belongs to.
      if (!explicitBilling || addressesEquivalent(shipping, billing)) {
        addTarget(entries, intent, "unknown", addressValue(shipping, intent));
      }
    }

    const values = new SemanticTargetValueMap(entries);
    return {
      values,
      billingStrategy,
      hasExplicitBillingAddress: Boolean(explicitBilling),
      preferBillingSameAsShippingControl: !explicitBilling,
      valueFor: target => values.valueFor(target)
    };
  }

  /**
   * Called when a shop has no usable "billing = shipping" control and exposes
   * explicit billing fields instead. Values remain separate billing:* targets
   * even when their strings equal shipping values.
   */
  useSeparateBillingFields(mapping: SemanticProfileMapping): SemanticProfileMapping {
    if (mapping.hasExplicitBillingAddress) return mapping;
    return { ...mapping, billingStrategy: "shipping-values-fallback", preferBillingSameAsShippingControl: false };
  }
}
