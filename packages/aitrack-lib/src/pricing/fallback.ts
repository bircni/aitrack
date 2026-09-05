import { log } from '../output.js';

/**
 * Records model ids that were priced by family fallback during one run.
 *
 * A fallback price is a guess: the model id had no exact entry, so the cost
 * written to the data file can be off by a whole tier, and the user needs to
 * know which models are affected.
 *
 * This used to be two module-level `Set`s inside the pricing tables, drained by
 * a `consume*FallbackHits()` pair. That made pricing lookups impure and
 * order-dependent, and it leaked from one long-lived run into the next — the
 * "consume" step existed only to paper over the shared state. Passing a
 * collector explicitly makes each run's hits its own.
 */
export interface FallbackCollector {
  record: (modelId: string) => void;
  /** Recorded ids, sorted, clearing them. */
  drain: () => string[];
}

export function createFallbackCollector(): FallbackCollector {
  const hits = new Set<string>();
  return {
    record: (modelId) => {
      hits.add(modelId);
    },
    drain: () => {
      const ids = [...hits].toSorted((a, b) => a.localeCompare(b));
      hits.clear();
      return ids;
    },
  };
}

/** Warn about models priced by family fallback. Shared by sync and recompute. */
export function reportFallbackPricing(fallbacks: FallbackCollector): void {
  const ids = fallbacks.drain();
  if (ids.length === 0) return;
  log.warn(
    `\nWarning: priced via family fallback (no exact pricing in src/pricing/): ${ids.join(', ')}`,
  );
  log.warn('  These costs may be wrong — update src/pricing/ with the correct rates.');
}
