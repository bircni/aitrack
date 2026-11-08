import { afterAll, beforeAll } from 'vitest';

/** The extremes of the UTC offset range, plus UTC itself: where local-day bugs show. */
export const EXTREME_TIME_ZONES = ['Pacific/Kiritimati', 'UTC', 'Pacific/Midway'] as const;

/** Runs the surrounding describe block in `timeZone`; Node re-reads TZ on the next Date operation. */
export function useTimeZone(timeZone: string): void {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = timeZone;
  });
  afterAll(() => {
    if (original === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = original;
    }
  });
}
