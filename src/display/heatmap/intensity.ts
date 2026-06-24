import { INTENSITY_THRESHOLDS } from './constants.js';

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const sortedAsc = [...sorted].sort((a, b) => a - b);
  const index = Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)));
  return sortedAsc[index] ?? 0;
}

function intensityLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!tokens || !max) return 0;
  const r = Math.min(tokens / max, 1);
  const [low, mid, high] = INTENSITY_THRESHOLDS;
  if (r < low) return 1;
  if (r < mid) return 2;
  if (r < high) return 3;
  return 4;
}

export function tokenIntensityLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  return intensityLevel(tokens, max);
}
