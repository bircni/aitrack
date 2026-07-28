import { describe, expect, it } from 'vitest';

import { fmt, fmtUSD, fmtUSDCost, pad } from '../format.js';

describe('format helpers', () => {
  it('formats token counts with K/M/B suffixes', () => {
    expect(fmt(500)).toBe('500');
    expect(fmt(1500)).toBe('1.5K');
    expect(fmt(2_500_000)).toBe('2.5M');
    expect(fmt(3_200_000_000)).toBe('3.20B');
  });

  it('promotes to the next unit instead of rounding past it', () => {
    expect(fmt(999_999)).toBe('1.0M');
    expect(fmt(999_999_999)).toBe('1.00B');
  });

  it('keeps values that round within their own unit', () => {
    expect(fmt(999_949)).toBe('999.9K');
    expect(fmt(999_949_999)).toBe('999.9M');
  });

  it('formats USD amounts for tables', () => {
    expect(fmtUSD(null)).toBe('—');
    expect(fmtUSD(0)).toBe('—');
    expect(fmtUSD(0.005)).toBe('<$0.01');
    expect(fmtUSD(12.5)).toBe('$12.50');
  });

  it('formats known USD costs including zero', () => {
    expect(fmtUSDCost(0)).toBe('$0.00');
    expect(fmtUSDCost(0.005)).toBe('<$0.01');
    expect(fmtUSDCost(4.5)).toBe('$4.50');
  });

  it('pads strings left and right', () => {
    expect(pad('x', 4, 'left')).toBe('x   ');
    expect(pad('x', 4, 'right')).toBe('   x');
    expect(pad('longer', 3, 'left')).toBe('longer');
  });
});
