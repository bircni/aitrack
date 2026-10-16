import { INTENSITY_THRESHOLDS } from './constants.js';

/** Nearest-rank: floor(p * (n - 1)) made the quieter of two days the ceiling. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sortedAsc = values.toSorted((a, b) => a - b);
  const rank = Math.ceil(p * sortedAsc.length) - 1;
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[index] ?? 0;
}

export function tokenIntensityLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!tokens || !max) return 0;
  const r = Math.min(tokens / max, 1);
  const [low, mid, high] = INTENSITY_THRESHOLDS;
  if (r < low) return 1;
  if (r < mid) return 2;
  if (r < high) return 3;
  return 4;
}
