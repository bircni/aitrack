import { describe, expect, it } from 'vitest';

import { budgetStatus } from '../budget.js';

describe('budgetStatus', () => {
  it('is null when no budget is set', () => {
    expect(budgetStatus(50, 0)).toBeNull();
    expect(budgetStatus(50, Number.NaN)).toBeNull();
    expect(budgetStatus(50, -10)).toBeNull();
  });

  it('reports "ok" below the warn threshold', () => {
    expect(budgetStatus(40, 200)).toMatchObject({ level: 'ok', ratio: 0.2, overUSD: 0 });
  });

  it('reports "warn" from 80% up to the limit', () => {
    expect(budgetStatus(160, 200)).toMatchObject({ level: 'warn', overUSD: 0 });
    expect(budgetStatus(199.99, 200)?.level).toBe('warn');
  });

  it('reports "over" at or above the limit, with the overage', () => {
    expect(budgetStatus(200, 200)).toMatchObject({ level: 'over', overUSD: 0 });
    expect(budgetStatus(243.1, 200)).toMatchObject({ level: 'over' });
    expect(budgetStatus(243.1, 200)?.overUSD).toBeCloseTo(43.1);
  });
});
