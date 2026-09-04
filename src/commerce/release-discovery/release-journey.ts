import type { Page } from "patchright";
import type { CommerceShop } from "../platforms";
import type { ProductObservation } from "../../monitor/models";

export interface ReleaseDiscoveryInput {
  productName: string;
  keywords: string[];
}

export interface ReleaseJourney {
  supports(shop: CommerceShop): boolean;
  discover(page: Page, shop: CommerceShop, input: ReleaseDiscoveryInput): Promise<ProductObservation | undefined>;
  addToCart(page: Page, shop: CommerceShop, product: ProductObservation): Promise<void>;
  openCheckout(page: Page, shop: CommerceShop): Promise<void>;
  submitOrder(page: Page, shop: CommerceShop, allowFinalPurchase: () => boolean): Promise<boolean>;
}
