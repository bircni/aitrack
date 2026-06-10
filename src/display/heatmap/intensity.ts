export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const sortedAsc = [...sorted].sort((a, b) => a - b);
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)));
  return sortedAsc[idx] ?? 0;
}

function intensityLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!tokens || !max) return 0;
  const r = Math.min(tokens / max, 1);
  if (r < 0.1) return 1;
  if (r < 0.35) return 2;
  if (r < 0.65) return 3;
  return 4;
}

export function tokenIntensityLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  return intensityLevel(tokens, max);
}
