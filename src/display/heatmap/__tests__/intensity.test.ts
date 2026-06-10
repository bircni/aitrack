import { describe, expect, it } from 'vitest';

import { percentile } from '../intensity.js';

describe('percentile', () => {
  it('picks the value at the requested rank', () => {
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1, 1, 1, 1, 1, 1, 1, 1, 1, 1000], 0.9)).toBe(1);
  });
});
