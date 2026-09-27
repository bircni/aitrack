import { expect, it } from 'vitest';

import { costWindow, daysIn, sumCost } from '../costWindow';

const today = '2026-09-27';

it('keeps the last 30 days and the 30 days before them', () => {
  const window = costWindow('30', today, '', '');
  expect(window.current).toEqual({ from: '2026-08-28', to: '2026-09-27' });
  expect(window.previous).toEqual({ from: '2026-07-29', to: '2026-08-27' });
  expect(window.currentLabel).toBe('Last 30 days');
  expect(window.previousLabel).toBe('Previous 30 days');
  const rows = [
    { day: '2026-08-28', costUsd: 1 },
    { day: '2026-08-27', costUsd: 4 },
    { day: '2026-07-28', costUsd: 9 },
  ];
  expect(sumCost(daysIn(rows, window.current))).toBe(1);
  expect(sumCost(daysIn(rows, window.previous ?? { from: null, to: null }))).toBe(4);
});

it('compares today with yesterday and a custom range with the days before it', () => {
  const todayWindow = costWindow('today', today, '', '');
  expect(todayWindow.current).toEqual({ from: today, to: today });
  expect(todayWindow.previous).toEqual({ from: '2026-09-26', to: '2026-09-26' });
  const custom = costWindow('custom', today, '2026-09-03', '2026-09-01');
  expect(custom.current).toEqual({ from: '2026-09-01', to: '2026-09-03' });
  expect(custom.previous).toEqual({ from: '2026-08-29', to: '2026-08-31' });
  expect(costWindow('all', today, '', '').previous).toBeNull();
});
