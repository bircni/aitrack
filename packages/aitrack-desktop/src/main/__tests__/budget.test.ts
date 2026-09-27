import { describe, expect, it } from 'vitest';

import { calendarMonthSpend, withMonthlyBudget } from '../budget.js';

describe('monthly budget', () => {
  it('sums only the calendar month of today', () => {
    const spent = calendarMonthSpend(
      [
        { day: '2026-09-01', costUsd: 2 },
        { day: '2026-09-20', costUsd: 3.5 },
        { day: '2026-08-31', costUsd: 9 },
      ],
      '2026-09-27',
    );
    expect(spent).toBe(5.5);
  });

  it('writes a positive ceiling and clears a missing one', () => {
    const config = { repoUrl: 'git@example.com:me/data.git', machineId: 'laptop' };
    expect(withMonthlyBudget(config, 200)).toEqual({
      ...config,
      budget: { monthlyUSD: 200 },
    });
    expect(withMonthlyBudget({ ...config, budget: { monthlyUSD: 200 } }, null)).toEqual(config);
    expect(withMonthlyBudget(config, 0)).toEqual(config);
  });
});
