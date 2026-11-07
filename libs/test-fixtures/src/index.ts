import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, vi } from 'vitest';

interface FixtureTokenCounts {
  inputTokens: number;
  outputTokens: number;
  rawInputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  costUSD?: number;
  hasUnpricedTokens?: boolean;
}

interface FixtureDayEntry extends FixtureTokenCounts {
  byModel: Record<string, FixtureTokenCounts>;
  byProject?: Record<string, FixtureTokenCounts>;
  byCwd?: Record<string, FixtureTokenCounts>;
}

interface FixtureProviderDay {
  byModel: Record<string, FixtureTokenCounts>;
  totals: FixtureTokenCounts;
  byProject?: Record<string, FixtureTokenCounts>;
  byCwd?: Record<string, FixtureTokenCounts>;
}

interface FixtureMachineFile {
  schemaVersion: number;
  hostname: string;
  timezone: string;
  dayBucket: 'utc' | 'local';
  lastUpdated: string;
  days: Record<string, Record<string, FixtureProviderDay>>;
}

export function writeJsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
}

/**
 * An ISO instant that falls on the given **local** calendar date, so its day
 * key holds in every zone (midday UTC is already tomorrow at UTC+14).
 */
export function localTimestamp(date: string, hour = 12): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour).toISOString();
}

/** The extremes of the UTC offset range, plus UTC itself: where local-day bugs show. */
export const EXTREME_TIME_ZONES = ['Pacific/Kiritimati', 'UTC', 'Pacific/Midway'] as const;

/**
 * Run the surrounding describe block in `timeZone`. Node re-reads TZ on the
 * next Date operation, so this moves the process for real rather than mocking Date.
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

/** The persisted shape of a provider's day, with totals mirroring byModel. */
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

/** A current-schema machine file, for tests where the header is not the point. */
export function makeMachineFile(
  hostname: string,
  days: FixtureMachineFile['days'] = {},
  overrides: Partial<FixtureMachineFile> = {},
): FixtureMachineFile {
  return {
    schemaVersion: 2,
    hostname,
    timezone: 'UTC',
    dayBucket: 'utc',
    lastUpdated: 'now',
    days,
    ...overrides,
  };
}

const LIVE_PROVIDERS = new Set(['cursor']);

function currentZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * What the loader returns for this already-merged data: one machine in the current zone holding the
 * synced providers, with the live ones kept apart.
 */
export function loadedFrom(providerData: Record<string, Map<string, FixtureDayEntry>>) {
  const days: FixtureMachineFile['days'] = {};
  const liveProviderData: Record<string, Map<string, FixtureDayEntry>> = {};
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    if (LIVE_PROVIDERS.has(providerKey)) {
      liveProviderData[providerKey] = dayMap;
      continue;
    }
    for (const [date, { byModel, byProject, byCwd, ...totals }] of dayMap) {
      (days[date] ??= {})[providerKey] = {
        byModel,
        totals,
        ...(byProject && { byProject }),
        ...(byCwd && { byCwd }),
      };
    }
  }
  return {
    providerData,
    liveProviderData,
    zonedSources: [
      { hostname: 'host', timezone: currentZone(), lastUpdated: '', current: true, days },
    ],
  };
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

/** Absolute path of a checked-in provider log sample under `src/providers`. */
export function providerFixture(name: string): string {
  return fileURLToPath(new URL(`./providers/${name}`, import.meta.url));
}
