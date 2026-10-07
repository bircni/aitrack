import { isDayKey } from 'aitrack-lib/constants';
import {
  invalidDateMessage,
  isUsagePeriod,
  parsePositiveInteger,
  USAGE_PERIOD_DEFINITIONS,
  usagePeriodDefinition,
} from 'aitrack-lib/data/usagePeriods';
import type { UsageReportOptions } from 'aitrack-lib/data/usageReport';
import { normalizeProviderKey, providerKeys } from 'aitrack-lib/providers/index';
import { InvalidArgumentError } from 'commander';

/** Commander option parser: a bare YYYY-MM-DD date, or a friendly rejection. */
export function parseDateOption(value: string): string {
  if (!isDayKey(value)) {
    throw new InvalidArgumentError(invalidDateMessage(value));
  }
  return value;
}

export function parsePositiveIntArgument(value: string): number {
  const n = parsePositiveInteger(value);
  if (n === null) throw new InvalidArgumentError(`Expected a positive integer, got: ${value}`);
  return n;
}

/** Day keys are four-digit years. */
export function parseYearArgument(value: string): number {
  const year = parsePositiveIntArgument(value);
  if (year > 9999) throw new InvalidArgumentError(`Expected a year up to 9999, got: ${value}`);
  return year;
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
        `Invalid provider: "${name}". Expected one of: ${providerKeys().join(', ')}.`,
      );
    }
    seen.add(key);
  }
  if (seen.size === 0) {
    throw new InvalidArgumentError(
      `No valid providers given. Expected one of: ${providerKeys().join(', ')}.`,
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

  return { period, providers, ...usagePeriodDefinition(period).parseArgs(args) };
}
