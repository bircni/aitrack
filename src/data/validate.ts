import type { MachineFile, ProviderDay, TokenCounts } from './types.js';

export interface MachineFileValidationOptions {
  /** Let recompute-costs load a file whose aggregate cost is the value being repaired. */
  allowInconsistentCostTotals?: boolean;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Files already warned about below, so the message stays a one-shot per run. */
const warnedBadDayKeys = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateTokenCounts(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!isFiniteNumber(value.inputTokens)) return `${path}.inputTokens must be a number`;
  if (!isFiniteNumber(value.outputTokens)) return `${path}.outputTokens must be a number`;
  if (value.cachedInputTokens !== undefined && !isFiniteNumber(value.cachedInputTokens)) {
    return `${path}.cachedInputTokens must be a number`;
  }
  if (
    value.cacheCreationInputTokens !== undefined &&
    !isFiniteNumber(value.cacheCreationInputTokens)
  ) {
    return `${path}.cacheCreationInputTokens must be a number`;
  }
  if (value.rawInputTokens !== undefined && !isFiniteNumber(value.rawInputTokens)) {
    return `${path}.rawInputTokens must be a number`;
  }
  if (value.costUSD !== undefined && !isFiniteNumber(value.costUSD)) {
    return `${path}.costUSD must be a number`;
  }
  return null;
}

/** Float comparison with a relative epsilon, used for cost totals. */
export function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function sumField(byModel: TokenCounts[], field: keyof TokenCounts): number {
  return byModel.reduce((sum, counts) => sum + (counts[field] ?? 0), 0);
}

function validateProviderDay(
  value: unknown,
  path: string,
  options: MachineFileValidationOptions,
): string | null {
  if (!isRecord(value)) return `${path} must be an object`;
  const totalsError = validateTokenCounts(value.totals, `${path}.totals`);
  if (totalsError) return totalsError;
  if (!isRecord(value.byModel)) return `${path}.byModel must be an object`;
  const byModel: TokenCounts[] = [];
  for (const [model, counts] of Object.entries(value.byModel)) {
    const error = validateTokenCounts(counts, `${path}.byModel.${model}`);
    if (error) return error;
    byModel.push(counts as TokenCounts);
  }

  const totals = value.totals as TokenCounts;
  for (const field of ['inputTokens', 'outputTokens'] as const) {
    if (totals[field] !== sumField(byModel, field)) {
      return `${path}.totals.${field} must equal the sum of byModel.${field}`;
    }
  }
  for (const field of [
    'rawInputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
  ] as const) {
    if (totals[field] !== undefined && totals[field] !== sumField(byModel, field)) {
      return `${path}.totals.${field} must equal the sum of byModel.${field}`;
    }
  }
  if (
    !options.allowInconsistentCostTotals &&
    totals.costUSD !== undefined &&
    byModel.length > 0 &&
    byModel.every((counts) => counts.costUSD !== undefined) &&
    !approximatelyEqual(totals.costUSD, sumField(byModel, 'costUSD'))
  ) {
    return `${path}.totals.costUSD must equal the sum of byModel.costUSD`;
  }
  return null;
}

export function validateMachineFile(
  data: unknown,
  filePath: string,
  options: MachineFileValidationOptions = {},
): MachineFile | null {
  if (!isRecord(data)) {
    console.warn(`Skipping invalid machine file ${filePath}: root must be an object`);
    return null;
  }
  if (typeof data.hostname !== 'string' || data.hostname.length === 0) {
    console.warn(`Skipping invalid machine file ${filePath}: hostname must be a non-empty string`);
    return null;
  }
  if (typeof data.lastUpdated !== 'string' || data.lastUpdated.length === 0) {
    console.warn(
      `Skipping invalid machine file ${filePath}: lastUpdated must be a non-empty string`,
    );
    return null;
  }
  if (!isRecord(data.days)) {
    console.warn(`Skipping invalid machine file ${filePath}: days must be an object`);
    return null;
  }

  const days: MachineFile['days'] = {};
  for (const [date, providers] of Object.entries(data.days)) {
    // A day key that is not a date can only come from a reader that wrote one
    // (an unparseable timestamp used to yield "NaN-NaN-NaN"). Such a day is
    // skipped by every year and window filter yet still counted in all-time
    // totals, and nothing removes it on its own: the sync merge carries
    // persisted days forward forever. Drop it on read instead of failing the
    // whole file, which would take the machine's real history with it.
    //
    // Warn once per file per process: only the current machine self-heals (sync
    // rewrites it), so for another machine's file this would otherwise print on
    // every command and every daemon tick with nothing the local user can do.
    if (!DAY_KEY.test(date)) {
      if (!warnedBadDayKeys.has(filePath)) {
        warnedBadDayKeys.add(filePath);
        console.warn(`Dropping day ${date} from machine file ${filePath}: not a YYYY-MM-DD date`);
      }
      continue;
    }
    if (!isRecord(providers)) {
      console.warn(`Skipping invalid machine file ${filePath}: days.${date} must be an object`);
      return null;
    }
    const providerDay: Record<string, ProviderDay> = {};
    for (const [providerKey, providerData] of Object.entries(providers)) {
      const error = validateProviderDay(providerData, `days.${date}.${providerKey}`, options);
      if (error) {
        console.warn(`Skipping invalid machine file ${filePath}: ${error}`);
        return null;
      }
      providerDay[providerKey] = providerData as ProviderDay;
    }
    days[date] = providerDay;
  }

  return {
    hostname: data.hostname,
    lastUpdated: data.lastUpdated,
    days,
  };
}

export function parseMachineFile(
  raw: string,
  filePath: string,
  options: MachineFileValidationOptions = {},
): MachineFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping invalid machine file ${filePath}: invalid JSON (${message})`);
    return null;
  }
  return validateMachineFile(parsed, filePath, options);
}
