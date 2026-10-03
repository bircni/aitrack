import { EXTREME_TIME_ZONES, makeDay, useTimeZone } from '@aitrack/test-fixtures';
import type { DayEntry } from 'aitrack-lib/data/types';
import { expect, it, describe } from 'vitest';

import { summarizeUsage } from '../usage.js';

for (const zone of EXTREME_TIME_ZONES) {
  describe(`desktop report clock in ${zone}`, () => {
    useTimeZone(zone);
    it('anchors report periods and chart days to the same supplied calendar instant', () => {
      const now = new Date('2026-01-01T00:15:00Z');
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
      const day: DayEntry = makeDay(10, 2, 1);
      for (const counts of Object.values(day.byModel)) counts.hasUnpricedTokens = true;
      const summary = summarizeUsage(
        { machineData: [], providerData: { claude_code: new Map([[date, day]]) } },
        now,
      );
      expect(summary.providers.claude_code?.today).toMatchObject({
        tokens: 12,
        costUSD: 1,
        hasUnpricedTokens: true,
      });
      expect(summary.providers.claude_code?.daily.at(-1)).toEqual({ date, costUSD: 1 });
    });
  });
}
