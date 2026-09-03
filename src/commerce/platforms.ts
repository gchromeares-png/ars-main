export const COMMERCE_PLATFORMS = [
  "shopify",
  "woocommerce",
  "jtl",
  "wix",
  "shopware",
  "magento",
  "bigcommerce",
  "prestashop",
  "squarespace",
  "ecwid",
  "lightspeed",
  "commercetools",
  "salesforce-commerce-cloud",
  "custom"
] as const;

export type CommercePlatform = typeof COMMERCE_PLATFORMS[number];

export interface CommerceShop {
  id: string;
  name: string;
  baseUrl: string;
  platform: CommercePlatform;
  config: Record<string, unknown>;
}

export function isCommercePlatform(value: unknown): value is CommercePlatform {
  return typeof value === "string" && (COMMERCE_PLATFORMS as readonly string[]).includes(value);
}

export function normalizeCommercePlatform(value: unknown): CommercePlatform | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isCommercePlatform(normalized) ? normalized : undefined;
}
