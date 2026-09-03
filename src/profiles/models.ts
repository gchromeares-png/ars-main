import type { StoredPaymentPreference } from "../payments/models";

export interface ProxyConfig {
  protocol?: "http" | "https" | "socks5";
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

export interface AddressProfile {
  address1: string;
  address2?: string;
  postalCode: string;
  city: string;
  countryCode: string;
}

export interface ContactProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}

export interface BrowserProfileConfig {
  headless?: boolean;
  userAgent?: string;
}

export interface AresProfile {
  id: string;
  name: string;
  contact: ContactProfile;
  address: AddressProfile;
  /** Legacy inline proxy config. New UI uses preferredProxyId + Proxy Vault. */
  proxy?: ProxyConfig;
  preferredProxyId?: string;
  browser?: BrowserProfileConfig;
  /** Non-sensitive preference only. Card number/CVV are session-only and never stored here. */
  paymentPreference?: StoredPaymentPreference;
}
