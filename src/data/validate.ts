import { isDayKey } from '../constants.js';
import { errorMessage } from '../errors.js';
import { reportMachineFileDiagnostics } from './diagnostics.js';
import { isFiniteNumber, isRecord } from './guards.js';
import type { MachineFile, ProviderDay, TokenCounts } from './types.js';

export interface MachineFileValidationOptions {
  /** Let recompute-costs load a file whose aggregate cost is the value being repaired. */
  allowInconsistentCostTotals?: boolean;
}

/**
 * Something the reader noticed about a machine file.
 *
 * Validation used to `console.warn` at eight sites, which meant the data layer
 * decided how problems were presented and every caller inherited that choice.
 * Returning the findings lets the command decide — and lets a test assert on
 * them without spying on the console.
 */
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

/**
 * Validate token counts and hand back the value.
 *
 * Returning the value rather than only an error message is what removes the
 * casts the callers used to need: a validator that returns `string | null`
 * cannot narrow anything for the type checker, so every success path had to
 * assert the type again. The one remaining assertion is here, next to the
 * checks that justify it.
 */
function checkTokenCounts(value: unknown, path: string): Checked<TokenCounts> {
  if (!isRecord(value)) return invalid(`${path} must be an object`);
  if (!isFiniteNumber(value.inputTokens)) return invalid(`${path}.inputTokens must be a number`);
  if (!isFiniteNumber(value.outputTokens)) return invalid(`${path}.outputTokens must be a number`);
  for (const field of [
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'rawInputTokens',
    'costUSD',
  ] as const) {
    const present = value[field];
    if (present !== undefined && !isFiniteNumber(present)) {
      return invalid(`${path}.${field} must be a number`);
    }
  }

  // The original object, not a rebuilt one: sync writes what it read back out,
  // and reconstructing this would reorder the keys and produce a spurious diff
  // on every already-up-to-date machine. The cast is sound because every field
  // TokenCounts declares has just been checked.
  return { ok: true, value: value as unknown as TokenCounts };
}

/** Float comparison with a relative epsilon, used for cost totals. */
export function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function sumField(byModel: TokenCounts[], field: keyof TokenCounts): number {
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
  if (typeof data.hostname !== 'string' || data.hostname.length === 0) {
    return skip('hostname must be a non-empty string');
  }
  if (typeof data.lastUpdated !== 'string' || data.lastUpdated.length === 0) {
    return skip('lastUpdated must be a non-empty string');
  }
  if (!isRecord(data.days)) return skip('days must be an object');

  const diagnostics: MachineFileDiagnostic[] = [];
  const days: MachineFile['days'] = {};

  for (const [date, providers] of Object.entries(data.days)) {
    // A day key that is not a date can only come from a reader that wrote one
    // (an unparseable timestamp used to yield "NaN-NaN-NaN"). Such a day is
    // skipped by every year and window filter yet still counted in all-time
    // totals, and nothing removes it on its own: the sync merge carries
    // persisted days forward forever. Drop it on read instead of failing the
    // whole file, which would take the machine's real history with it.
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
    machine: { hostname: data.hostname, lastUpdated: data.lastUpdated, days },
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
