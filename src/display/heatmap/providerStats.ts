import { sumDayMap } from '../../data/aggregate.js';
import type { DayMap } from '../../data/types.js';
import { currentStreak, longestStreak, peakMonth } from './stats.js';

/**
 * The headline numbers for one provider, unformatted.
 *
 * The terminal table and the PNG/HTML stat cells show the same six figures in
 * different shapes, and each used to derive them itself — so a change to what
 * counts as an "active day" had to be made twice to keep the two agreeing.
 * Formatting stays with the renderer; only the arithmetic is shared.
 */
export interface ProviderStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  /** False when no day in the range carried a cost, which renders as an em dash. */
  hasCost: boolean;
  /** Days with at least one token, so an empty day never inflates the count. */
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakMonth: { month: string; tokens: number } | null;
}

export function providerStats(dayMap: DayMap): ProviderStats {
  const { inputTokens, outputTokens, costUSD, hasCost, days } = sumDayMap(dayMap);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUSD,
    hasCost,
    activeDays: days,
    currentStreak: currentStreak(dayMap),
    longestStreak: longestStreak(dayMap),
    peakMonth: peakMonth(dayMap),
  };
}
