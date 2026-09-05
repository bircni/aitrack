import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, vi } from 'vitest';

interface FixtureTokenCounts {
  inputTokens: number;
  outputTokens: number;
  costUSD?: number;
}

interface FixtureDayEntry extends FixtureTokenCounts {
  byModel: Record<string, FixtureTokenCounts>;
}

interface FixtureProviderDay {
  byModel: Record<string, FixtureTokenCounts>;
  totals: FixtureTokenCounts;
}

/**
 * Fixtures shared by the test suite.
 *
 * Eleven test files had grown their own copy of makeDay and eight their own
 * console-capture helper, all identical bar the default model name — so a
 * change to DayEntry meant editing nineteen near-duplicates.
 */

/**
 * Write a JSONL file, one object per line.
 *
 * Four reader tests had each grown an identical copy of this.
 */
export function writeJsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
}

/**
 * An ISO instant that falls on the given **local** calendar date.
 *
 * Readers key usage by the local day a request happened on, so a fixture
 * written as a fixed UTC instant does not mean a fixed day key: midday UTC on
 * 2024-01-15 is already 2024-01-16 at UTC+14 and still 2024-01-14 at UTC-11.
 * Building the instant from local components keeps the day key the same in
 * every timezone, which is what assertions like `result.get('2024-01-15')`
 * are actually claiming.
 */
export function localTimestamp(date: string, hour = 12): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour).toISOString();
}

/**
 * The extremes of the UTC offset range, plus UTC itself.
 *
 * Usage is keyed by the local calendar day, so a helper that reads local date
 * components can be correct at UTC and a whole day out at either edge. CI
 * runners are UTC, which hid exactly that until someone ran the suite in NZ —
 * so the edges belong in the suite, not in how CI happens to invoke it.
 */
export const EXTREME_TIME_ZONES = ['Pacific/Kiritimati', 'UTC', 'Pacific/Midway'] as const;

/**
 * Run the surrounding describe block in `timeZone`.
 *
 * Node re-reads process.env.TZ on the next Date operation, so this moves the
 * process into the zone for real rather than mocking the Date API — which is
 * the point: the code under test uses getFullYear/getMonth/getDate, and a
 * mocked Date would only prove the mock agrees with itself.
 */
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

/** A day whose tokens all sit on one model, which is what most assertions need. */
export function makeDay(
  inputTokens: number,
  outputTokens: number,
  costUSD?: number,
  model = 'model',
): FixtureDayEntry {
  const counts = {
    inputTokens,
    outputTokens,
    ...(costUSD !== undefined && { costUSD }),
  };
  return { ...counts, byModel: { [model]: { ...counts } } };
}

/**
 * The persisted shape of a provider's day, with totals mirroring byModel.
 *
 * Only for cases where that mirroring is incidental — the tests that exercise
 * the merge and validation rules build totals that deliberately disagree with
 * byModel, and spelling those out is the point of those fixtures.
 */
export function makeProviderDay(
  inputTokens: number,
  outputTokens: number,
  costUSD?: number,
  model = 'model',
): FixtureProviderDay {
  const counts = {
    inputTokens,
    outputTokens,
    ...(costUSD !== undefined && { costUSD }),
  };
  return { byModel: { [model]: { ...counts } }, totals: { ...counts } };
}

/**
 * Everything written to a console method since it was spied on, newline-joined.
 * Callers install the spy themselves, usually in beforeEach.
 */
export function loggedOutput(method: 'log' | 'warn' | 'error' = 'log'): string {
  return vi
    .mocked(console[method])
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}
