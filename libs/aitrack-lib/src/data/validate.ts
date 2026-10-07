import { isDayKey } from '../constants.js';
import { errorMessage } from '../errors.js';
import { applyMigrations } from '../store/migrations/index.js';
import { UNKNOWN_TIMEZONE } from '../timezone.js';
import { reportMachineFileDiagnostics } from './diagnostics.js';
import { isFiniteNumber, isRecord } from './guards.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import type { DayBucket, MachineFile, ProviderDay, TokenCounts } from './types.js';

export interface MachineFileValidationOptions {
  /** Let recompute-costs load a file whose aggregate cost is the value being repaired. */
  allowInconsistentCostTotals?: boolean;
}

/** Something the reader noticed about a machine file; the caller decides how to present it. */
export type MachineFileDiagnostic =
  | { kind: 'file-skipped'; filePath: string; reason: string }
  | { kind: 'day-dropped'; filePath: string; date: string; reason: string };

export interface MachineFileCheck {
  /** The validated file, or null when it had to be skipped entirely. */
  machine: MachineFile | null;
  diagnostics: MachineFileDiagnostic[];
}

/** A validated value, or the reason it is not one. */
type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Validate token counts and hand back the value. */
function checkTokenCounts(value: unknown, path: string): Checked<TokenCounts> {
  if (!isRecord(value)) return invalid(`${path} must be an object`);
  if (!isFiniteNumber(value.inputTokens)) return invalid(`${path}.inputTokens must be a number`);
  if (!isFiniteNumber(value.outputTokens)) return invalid(`${path}.outputTokens must be a number`);
  for (const field of [
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'cacheCreation1hInputTokens',
    'rawInputTokens',
    'costUSD',
  ] as const) {
    const present = value[field];
    if (present !== undefined && !isFiniteNumber(present)) {
      return invalid(`${path}.${field} must be a number`);
    }
  }

  if (value.hasUnpricedTokens !== undefined && typeof value.hasUnpricedTokens !== 'boolean') {
    return invalid(`${path}.hasUnpricedTokens must be a boolean`);
  }

  // The original object keeps the round trip byte-identical; every field was checked above.
  return { ok: true, value: value as unknown as TokenCounts };
}

/** Float comparison with a relative epsilon, used for cost totals. */
export function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function sumField(
  byModel: TokenCounts[],
  field: Exclude<keyof TokenCounts, 'hasUnpricedTokens'>,
): number {
  return byModel.reduce((sum, counts) => sum + (counts[field] ?? 0), 0);
}

function checkProviderDay(
  value: unknown,
  path: string,
  options: MachineFileValidationOptions,
): Checked<ProviderDay> {
  if (!isRecord(value)) return invalid(`${path} must be an object`);

  const checkedTotals = checkTokenCounts(value.totals, `${path}.totals`);
  if (!checkedTotals.ok) return checkedTotals;
  const totals = checkedTotals.value;

  if (!isRecord(value.byModel)) return invalid(`${path}.byModel must be an object`);
  const modelCounts: TokenCounts[] = [];
  for (const [model, counts] of Object.entries(value.byModel)) {
    const checked = checkTokenCounts(counts, `${path}.byModel.${model}`);
    if (!checked.ok) return checked;
    modelCounts.push(checked.value);
  }

  for (const field of ['inputTokens', 'outputTokens'] as const) {
    if (totals[field] !== sumField(modelCounts, field)) {
      return invalid(`${path}.totals.${field} must equal the sum of byModel.${field}`);
    }
  }
  for (const field of [
    'rawInputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'cacheCreation1hInputTokens',
  ] as const) {
    if (totals[field] !== undefined && totals[field] !== sumField(modelCounts, field)) {
      return invalid(`${path}.totals.${field} must equal the sum of byModel.${field}`);
    }
  }
  if (
    !options.allowInconsistentCostTotals &&
    totals.costUSD !== undefined &&
    modelCounts.length > 0 &&
    modelCounts.every((counts) => counts.costUSD !== undefined) &&
    !approximatelyEqual(totals.costUSD, sumField(modelCounts, 'costUSD'))
  ) {
    return invalid(`${path}.totals.costUSD must equal the sum of byModel.costUSD`);
  }

  // As above: hand back the object that was read, so a round-trip is byte-identical.
  return { ok: true, value: value as unknown as ProviderDay };
}

/** Validate a parsed machine file, reporting nothing. */
export function checkMachineFile(
  data: unknown,
  filePath: string,
  options: MachineFileValidationOptions = {},
): MachineFileCheck {
  const skip = (reason: string): MachineFileCheck => ({
    machine: null,
    diagnostics: [{ kind: 'file-skipped', filePath, reason }],
  });

  if (!isRecord(data)) return skip('root must be an object');

  // Silent: an older header is nothing the user has to act on.
  const diagnostics: MachineFileDiagnostic[] = [];
  let file: Record<string, unknown>;
  try {
    file = applyMigrations(data);
  } catch (error) {
    return skip(errorMessage(error));
  }

  if (typeof file.hostname !== 'string' || file.hostname.length === 0) {
    return skip('hostname must be a non-empty string');
  }
  if (typeof file.lastUpdated !== 'string' || file.lastUpdated.length === 0) {
    return skip('lastUpdated must be a non-empty string');
  }
  // Tolerated, not required: there is no repair path for another machine's file.
  const timezone =
    typeof file.timezone === 'string' && file.timezone.length > 0
      ? file.timezone
      : UNKNOWN_TIMEZONE;
  const dayBucket: DayBucket =
    file.dayBucket === 'utc' || file.dayBucket === 'local' ? file.dayBucket : 'local';
  if (!isRecord(file.days)) return skip('days must be an object');

  const days: MachineFile['days'] = {};

  for (const [date, providers] of Object.entries(file.days)) {
    // Drop the day, not the file: the sync merge would otherwise carry it forward forever.
    if (!isDayKey(date)) {
      diagnostics.push({ kind: 'day-dropped', filePath, date, reason: 'not a YYYY-MM-DD date' });
      continue;
    }
    if (!isRecord(providers)) {
      return skip(`days.${date} must be an object`);
    }
    const providerDay: Record<string, ProviderDay> = {};
    for (const [providerKey, providerData] of Object.entries(providers)) {
      const checked = checkProviderDay(providerData, `days.${date}.${providerKey}`, options);
      if (!checked.ok) return skip(checked.error);
      providerDay[providerKey] = checked.value;
    }
    days[date] = providerDay;
  }

  return {
    machine: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      hostname: file.hostname,
      timezone,
      dayBucket,
      lastUpdated: file.lastUpdated,
      days,
    },
    diagnostics,
  };
}

/** Parse and validate raw JSON, reporting nothing. */
export function checkRawMachineFile(
  raw: string,
  filePath: string,
  options: MachineFileValidationOptions = {},
): MachineFileCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      machine: null,
      diagnostics: [
        { kind: 'file-skipped', filePath, reason: `invalid JSON (${errorMessage(error)})` },
      ],
    };
  }
  return checkMachineFile(parsed, filePath, options);
}

/** Validate a parsed machine file, warning about whatever it found. */
export function validateMachineFile(
  data: unknown,
  filePath: string,
  options: MachineFileValidationOptions = {},
): MachineFile | null {
  const checked = checkMachineFile(data, filePath, options);
  reportMachineFileDiagnostics(checked.diagnostics);
  return checked.machine;
}

/** Parse and validate raw JSON, warning about whatever it found. */
export function parseMachineFile(
  raw: string,
  filePath: string,
  options: MachineFileValidationOptions = {},
): MachineFile | null {
  const checked = checkRawMachineFile(raw, filePath, options);
  reportMachineFileDiagnostics(checked.diagnostics);
  return checked.machine;
}
