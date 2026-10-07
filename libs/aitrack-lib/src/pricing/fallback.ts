import { log } from '../output.js';

/**
 * Records model ids that were priced by family fallback during one run.
 *
 * A fallback price is a guess: the model id had no exact entry, so the cost
 * written to the data file can be off by a whole tier, and the user needs to
 * know which models are affected.
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
    `\nWarning: priced via family fallback (no exact rate yet): ${ids.join(', ')} — costs may be off until aitrack or the pricing pack is updated.`,
  );
}
