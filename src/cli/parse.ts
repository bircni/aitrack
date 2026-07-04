import { InvalidArgumentError } from 'commander';

import type { TopKind, TopSort } from '../commands/top.js';
import { normalizeProviderKey, SELECTABLE_PROVIDERS } from '../display/providers.js';

export function cliErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isValidDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

export function invalidDateMessage(date: string): string {
  return `Invalid date: "${date}". Expected YYYY-MM-DD.`;
}

export function parseIntArg(value: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`Expected an integer, got: ${value}`);
  return n;
}

export function parsePositiveInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return n;
}

export function parseTopKind(kind: string | undefined): TopKind {
  return kind === 'models' ? 'models' : 'days';
}

export function topKindValidationError(kind: string | undefined): string | null {
  if (kind !== undefined && kind !== 'days' && kind !== 'models') {
    return `Invalid kind: "${kind}". Expected "days" or "models".`;
  }
  return null;
}

export function topSortValidationError(sort: string): string | null {
  if (sort !== 'tokens' && sort !== 'cost') {
    return `Invalid --sort value: "${sort}". Expected "tokens" or "cost".`;
  }
  return null;
}

export function parseTopSort(sort: string): TopSort {
  if (sort === 'cost') return 'cost';
  return 'tokens';
}

export function topLimitValidationError(limit: number): string | null {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return `Invalid --limit: "${String(limit)}". Expected a positive integer.`;
  }
  return null;
}

export function dateRangeValidationError(from: string, to: string): string | null {
  if (from > to) {
    return `Start date "${from}" must not be after end date "${to}".`;
  }
  return null;
}

/**
 * Parse the `--providers` value: a comma-separated list of provider names
 * (case-insensitive, friendly aliases accepted). Returns the canonical keys,
 * de-duplicated and order-preserved. Throws on any unknown name.
 */
export function parseProviders(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split(',')) {
    const name = raw.trim();
    if (name === '') continue;
    const key = normalizeProviderKey(name);
    if (key === null) {
      throw new InvalidArgumentError(
        `Invalid provider: "${name}". Expected one of: ${SELECTABLE_PROVIDERS.join(', ')}.`,
      );
    }
    seen.add(key);
  }
  if (seen.size === 0) {
    throw new InvalidArgumentError(
      `No valid providers given. Expected one of: ${SELECTABLE_PROVIDERS.join(', ')}.`,
    );
  }
  return [...seen];
}

export function usageLastDaysValidationError(n: string): string | null {
  if (parsePositiveInt(n) === undefined) {
    return `Invalid number of days: "${n}". Expected a positive integer.`;
  }
  return null;
}
