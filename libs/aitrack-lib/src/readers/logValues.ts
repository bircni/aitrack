import { tryLocalDateString } from '../data/dayMap.js';
import { isInheritedKey } from '../data/guards.js';
import { stripModelAliasSuffix } from '../data/modelId.js';

/**
 * Past this, enough records could sum beyond 2^53 and round differently per
 * model, and a machine file's totals must equal the sum of its rows exactly.
 */
const MAX_TOKENS_PER_RECORD = 2 ** 40;

export function isTokenCount(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TOKENS_PER_RECORD
  );
}

/** A token field a log may leave out or null, or a real count. */
export function isOptionalTokenCount(value: unknown): boolean {
  return value === undefined || value === null || isTokenCount(value);
}

function isPlainKey(value: string): boolean {
  return value !== '' && !isInheritedKey(value);
}

export function logCwd(value: unknown): string | undefined {
  return typeof value === 'string' && isPlainKey(value) ? value : undefined;
}

export function logModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const model = stripModelAliasSuffix(value);
  return isPlainKey(model) ? model : undefined;
}

/** A day key, or null: `Date` accepts years a `YYYY-MM-DD` key cannot hold. */
export function logDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = tryLocalDateString(value);
  return day !== null && /^\d{4}-/u.test(day) ? day : null;
}
