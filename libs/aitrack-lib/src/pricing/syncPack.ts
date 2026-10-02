import { sharedPricingStore } from './store.js';

/** Refresh cached pricing when due; failures retain current rates. */
export async function syncPricingPack(options?: {
  force?: boolean;
}): Promise<{ updatedAt: string; refreshed: boolean; detail: string }> {
  const result = await sharedPricingStore().refreshIfDue(options?.force === true);
  return {
    updatedAt: result.updatedAt,
    refreshed: result.updated,
    detail: result.reason,
  };
}
