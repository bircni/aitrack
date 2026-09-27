import { describe, expect, it } from 'vitest';

import { percentile, tokenIntensityLevel } from '../intensity.js';

describe('percentile', () => {
  it('picks the value at the requested rank', () => {
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1, 1, 1, 1, 1, 1, 1, 1, 1, 1000], 0.9)).toBe(1);
  });

  it('never returns a value below the median for an upper percentile', () => {
    // floor(p * (n - 1)) returned the minimum here.
    expect(percentile([100, 1_000_000], 0.9)).toBe(1_000_000);
    expect(percentile([1, 2, 3], 0.9)).toBe(3);
    expect(percentile([5, 10, 15, 20], 0.75)).toBe(15);
  });

  it('clamps the rank at both ends', () => {
    expect(percentile([4, 8, 15], 0)).toBe(4);
    expect(percentile([4, 8, 15], 1)).toBe(15);
  });

  it('keeps a quiet day dim when a busy day sets the ceiling', () => {
    const max = percentile([100, 1_000_000], 0.9);
    expect(tokenIntensityLevel(100, max)).toBe(1);
    expect(tokenIntensityLevel(1_000_000, max)).toBe(4);
  });
});
