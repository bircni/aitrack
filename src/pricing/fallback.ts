import { consumeClaudeFallbackHits } from './claude.js';
import { consumeCodexFallbackHits } from './codex.js';

/**
 * Warn about models priced by family fallback, clearing the run's hits.
 *
 * A fallback price is a guess: the model id had no exact entry, so the cost
 * written to the data file can be off by a whole tier. Clearing matters for the
 * daemon, which reads the logs on every tick and would otherwise re-report the
 * same models forever.
 *
 * Shared by the two commands that persist costs — sync and recompute-costs.
 */
export function reportFallbackPricing(): void {
  const fallbacks = [...consumeClaudeFallbackHits(), ...consumeCodexFallbackHits()];
  if (fallbacks.length === 0) return;
  console.warn(
    `\nWarning: priced via family fallback (no exact pricing in src/pricing/): ${fallbacks.join(', ')}`,
  );
  console.warn('  These costs may be wrong — update src/pricing/ with the correct rates.');
}
