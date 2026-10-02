import { ensurePricingStore, sharedPricingStore } from '../pricing/store.js';

/**
 * Load the disk-cached pricing pack and refresh from the orphan `pricing`
 * branch when the TTL is due. Failures are swallowed — local `tables/*.json`
 * rates stay in effect. Call from sync / recompute / doctor so installs pick
 * up rate fixes without a CLI release.
 */
export async function syncPricingPack(options?: {
  force?: boolean;
}): Promise<{ updatedAt: string; refreshed: boolean; detail: string }> {
  await ensurePricingStore();
  const result = await sharedPricingStore().refreshIfDue(options?.force === true);
  return {
    updatedAt: result.updatedAt,
    refreshed: result.updated,
    detail: result.reason,
  };
}
