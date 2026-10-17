const STALE_SYNC_MS = 3 * 86_400_000;

/** A machine that synced before but not for three days; one that never synced is reported separately. */
export function isStaleSync(lastUpdated: string, now: number): boolean {
  const at = Date.parse(lastUpdated);
  return !Number.isNaN(at) && now - at > STALE_SYNC_MS;
}
