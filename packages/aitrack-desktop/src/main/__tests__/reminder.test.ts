import { describe, expect, it } from 'vitest';

import { RATE_REMINDER_MS, ratingReminder } from '../reminder.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

describe('ratingReminder', () => {
  it('stays quiet until the reminder is on and a week has passed', () => {
    expect(ratingReminder({ enabled: false, unrated: 3, lastAt: null, now: NOW })).toBeNull();
    expect(ratingReminder({ enabled: true, unrated: 0, lastAt: null, now: NOW })).toBeNull();
    expect(ratingReminder({ enabled: true, unrated: 1, lastAt: null, now: NOW })).toBe(
      '1 session to rate',
    );
    expect(ratingReminder({ enabled: true, unrated: 3, lastAt: null, now: NOW })).toBe(
      '3 sessions to rate',
    );
    const recent = new Date(NOW - RATE_REMINDER_MS + 60_000).toISOString();
    expect(ratingReminder({ enabled: true, unrated: 3, lastAt: recent, now: NOW })).toBeNull();
    const due = new Date(NOW - RATE_REMINDER_MS - 60_000).toISOString();
    expect(ratingReminder({ enabled: true, unrated: 3, lastAt: due, now: NOW })).toBe(
      '3 sessions to rate',
    );
  });
});
