import { InvalidArgumentError } from 'commander';

import type { TopKind, TopSort } from '../commands/top.js';
import { MAX_INTERVAL_SECONDS } from '../config.js';
import type { UsageReportOptions } from '../data/usageReport.js';
import { normalizeProviderKey, SELECTABLE_PROVIDERS } from '../display/providers.js';
import {
  isNoArgPeriod,
  isUsagePeriod,
  USAGE_PERIOD_DEFINITIONS,
  type UsagePeriod,
} from '../display/usagePeriods.js';

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
  if (!/^-?\d+$/.test(value)) {
    throw new InvalidArgumentError(`Expected an integer, got: ${value}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(`Expected a safe integer, got: ${value}`);
  }
  return n;
}

export function parsePositiveIntArg(value: string): number {
  const n = parseIntArg(value);
  if (n < 1) {
    throw new InvalidArgumentError(`Expected a positive integer, got: ${value}`);
  }
  return n;
}

export function parseIntervalArg(value: string): number {
  const seconds = parsePositiveIntArg(value);
  if (seconds > MAX_INTERVAL_SECONDS) {
    throw new InvalidArgumentError(
      `Expected an interval between 1 and ${String(MAX_INTERVAL_SECONDS)} seconds, got: ${value}`,
    );
  }
  return seconds;
}

export function parsePortArg(value: string): number {
  const port = parsePositiveIntArg(value);
  if (port > 65_535) {
    throw new InvalidArgumentError(`Expected a port between 1 and 65535, got: ${value}`);
  }
  return port;
}

export function parsePositiveInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return n;
}

export function parseTopKind(kind: string | undefined): TopKind {
  if (kind !== undefined && kind !== 'days' && kind !== 'models') {
    throw new Error(`Invalid kind: "${kind}". Expected "days" or "models".`);
  }
  return kind === 'models' ? 'models' : 'days';
}

export function parseTopSort(sort: string): TopSort {
  if (sort !== 'tokens' && sort !== 'cost') {
    throw new Error(`Invalid --sort value: "${sort}". Expected "tokens" or "cost".`);
  }
  return sort;
}

export function parseTopLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`Invalid --limit: "${String(limit)}". Expected a positive integer.`);
  }
  return limit;
}

function invalidUsagePeriodMessage(period: string): string {
  const periods = USAGE_PERIOD_DEFINITIONS.map((def) => def.period).join(', ');
  return `Invalid period: "${period}". Expected one of: ${periods}.`;
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

export interface ParseUsageReportOptionsInput {
  period?: string;
  args?: string[];
  providers?: string[];
}

/** Parse `[period] [args...]` (export) or equivalent into shared usage-report options. */
export function parseUsageReportOptions(input: ParseUsageReportOptionsInput): UsageReportOptions {
  const period = input.period ?? 'month';
  const args = input.args ?? [];
  const { providers } = input;

  if (!isUsagePeriod(period)) {
    throw new Error(invalidUsagePeriodMessage(period));
  }

  return parseUsageReportOptionsForPeriod(period, args, providers);
}

function parseUsageReportOptionsForPeriod(
  period: UsagePeriod,
  args: string[],
  providers?: string[],
): UsageReportOptions {
  if (isNoArgPeriod(period)) {
    if (args.length > 0) {
      throw new Error(`Period "${period}" does not accept extra arguments.`);
    }
    return { period, providers };
  }

  if (period === 'date') {
    const [from, ...rest] = args;
    if (from === undefined || rest.length > 0) {
      throw new Error('Usage: aitrack export date <date>');
    }
    if (!isValidDateString(from)) throw new Error(invalidDateMessage(from));
    return { period: 'date', from, providers };
  }

  if (period === 'range') {
    const [from, to, ...rest] = args;
    if (from === undefined || to === undefined || rest.length > 0) {
      throw new Error('Usage: aitrack export range <from> <to>');
    }
    if (!isValidDateString(from)) throw new Error(invalidDateMessage(from));
    if (!isValidDateString(to)) throw new Error(invalidDateMessage(to));
    if (from > to) {
      throw new Error(`Start date "${from}" must not be after end date "${to}".`);
    }
    return { period: 'range', from, to, providers };
  }

  const [n, ...rest] = args;
  if (n === undefined || rest.length > 0) {
    throw new Error('Usage: aitrack export last <n>');
  }
  const parsed = parsePositiveInt(n);
  if (parsed === undefined) {
    throw new Error(`Invalid number of days: "${n}". Expected a positive integer.`);
  }
  return { period: 'last', n: parsed, providers };
}
