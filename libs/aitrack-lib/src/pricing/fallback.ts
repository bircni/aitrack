import { log } from '../output.js';

/** Family-fallback prices can be off by a tier, so the affected model ids are reported. */
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
