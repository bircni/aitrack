import { CLAUDE_FAMILIES } from '../data/modelId.js';
import type { CompactCatalog } from './codecs.js';
import type { PricingManifest, PricingSupplement } from './packMeta.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function rates(value: unknown, fields: string[]): boolean {
  return record(value) && fields.every((field) => amount(value[field]));
}

function map(value: unknown, validate: (value: unknown) => boolean): boolean {
  return record(value) && Object.values(value).every((entry) => validate(entry));
}

function stamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function pattern(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    new RegExp(value.startsWith('(?i)') ? value.slice(4) : value, 'u');
    return true;
  } catch {
    return false;
  }
}

function overrides(value: unknown, fields: string[]): boolean {
  return map(
    value,
    (entries) =>
      Array.isArray(entries) &&
      entries.every(
        (entry: unknown) => record(entry) && stamp(entry.before) && rates(entry.pricing, fields),
      ),
  );
}

const IO = ['inputPerMillion', 'outputPerMillion'];
const CLAUDE = [...IO, 'cacheReadPerMillion', 'cacheCreatePerMillion'];
const CURSOR = [...IO, 'cacheReadPerMillion', 'cacheWritePerMillion'];

export function isPricingSupplement(value: unknown): value is PricingSupplement {
  if (!record(value) || !stamp(value.updatedAt)) return false;
  const { claude, codex, cursor } = value;
  const fallback = record(claude) ? claude.familyFallback : undefined;
  return (
    record(claude) &&
    record(codex) &&
    record(cursor) &&
    map(claude.models, (row) => rates(row, CLAUDE)) &&
    overrides(claude.overrides, CLAUDE) &&
    record(fallback) &&
    CLAUDE_FAMILIES.every((family) => rates(fallback[family], CLAUDE)) &&
    map(codex.current, (row) => rates(row, IO)) &&
    map(codex.historical, (row) => rates(row, IO)) &&
    overrides(codex.overrides, IO) &&
    Array.isArray(codex.familyFallback) &&
    codex.familyFallback.every(
      (entry: unknown) => record(entry) && pattern(entry.match) && rates(entry, IO),
    ) &&
    map(cursor.models, (row) => rates(row, CURSOR)) &&
    map(cursor.fastMultipliers, amount) &&
    Array.isArray(cursor.aliases) &&
    cursor.aliases.every(
      (entry: unknown) =>
        record(entry) && pattern(entry.pattern) && typeof entry.canonical === 'string',
    )
  );
}

export function isCompactCatalog(value: unknown): value is CompactCatalog {
  return (
    record(value) &&
    stamp(value.retrievedAt) &&
    record(value.models) &&
    Object.keys(value.models).length > 0 &&
    map(
      value.models,
      (row) =>
        rates(row, ['i', 'o', 'cw', 'cr']) &&
        record(row) &&
        ['ia', 'oa', 'cwa', 'cra', 'fast'].every(
          (field) => row[field] === undefined || amount(row[field]),
        ) &&
        ['cre', 'cwe'].every(
          (field) => row[field] === undefined || typeof row[field] === 'boolean',
        ),
    )
  );
}

export function isPricingManifest(value: unknown): value is PricingManifest {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !stamp(value.updatedAt) ||
    !record(value.files)
  )
    return false;
  const hashes = value.hashes;
  return (
    value.files.supplement === 'supplement.json' &&
    value.files.litellm === 'litellm.json' &&
    value.files.modelsDev === 'models_dev.json' &&
    record(hashes) &&
    ['supplement', 'litellm', 'modelsDev'].every(
      (key) => typeof hashes[key] === 'string' && /^[a-f0-9]{64}$/u.test(hashes[key]),
    )
  );
}
