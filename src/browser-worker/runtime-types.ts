export interface ShopifyRuntimeShop {
  id: string;
  name: string;
  baseUrl: string;
  platform: "shopify";
  config: Record<string, unknown>;
}
