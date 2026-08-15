import { vi } from 'vitest';

import type { DayEntry, ProviderDay } from '../../data/types.js';

/**
 * Fixtures shared by the test suite.
 *
 * Eleven test files had grown their own copy of makeDay and eight their own
 * console-capture helper, all identical bar the default model name — so a
 * change to DayEntry meant editing nineteen near-duplicates.
 */

/** A day whose tokens all sit on one model, which is what most assertions need. */
export function makeDay(
  inputTokens: number,
  outputTokens: number,
  costUSD?: number,
  model = 'model',
): DayEntry {
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
): ProviderDay {
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
