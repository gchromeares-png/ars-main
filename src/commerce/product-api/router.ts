import {
  getCommercePlatformCapability,
  type CommercePlatform,
  type CommerceShop
} from "../platforms";
import type { ProductObservation, ProductQuery } from "../../monitor/models";
import { ShopifyProductApiAdapter } from "./shopify-product-api-adapter";
import { WooCommerceProductApiAdapter } from "./woocommerce-product-api-adapter";
import type { CommerceProductApiAdapter, ProductApiProbeResult } from "./types";

export class CommerceProductApiRouter {
  private readonly adapters = new Map<CommercePlatform, CommerceProductApiAdapter>();

  constructor(registerDefaults = true) {
    if (registerDefaults) {
      this.register(new ShopifyProductApiAdapter());
      this.register(new WooCommerceProductApiAdapter());
    }
  }

  register(adapter: CommerceProductApiAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  hasAdapter(platform: CommercePlatform): boolean {
    return this.adapters.has(platform);
  }

  listAdapterPlatforms(): CommercePlatform[] {
    return [...this.adapters.keys()];
  }

  async probe(shop: CommerceShop): Promise<ProductApiProbeResult> {
    const adapter = this.adapters.get(shop.platform);
    if (adapter) return adapter.probe(shop);

    const capability = getCommercePlatformCapability(shop.platform);
    return {
      platform: shop.platform,
      endpoint: capability.productEndpoint || shop.baseUrl,
      reachable: false,
      publicReadable: false,
      reason: capability.notes
    };
  }

  async search(shop: CommerceShop, query: ProductQuery, limit = 50): Promise<ProductObservation[]> {
    const adapter = this.adapters.get(shop.platform);
    if (!adapter) {
      const capability = getCommercePlatformCapability(shop.platform);
      throw new Error(
        `No anonymous product API adapter for ${shop.platform}. Access mode: ${capability.productApi}. ${capability.notes}`
      );
    }
    return adapter.search(shop, query, limit);
  }
}
