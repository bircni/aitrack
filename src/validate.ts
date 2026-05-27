import type { MachineFile, ProviderDay } from './types.js';

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

function validateProviderDay(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} must be an object`;
  const totalsError = validateTokenCounts(value.totals, `${path}.totals`);
  if (totalsError) return totalsError;
  if (!isRecord(value.byModel)) return `${path}.byModel must be an object`;
  for (const [model, counts] of Object.entries(value.byModel)) {
    const error = validateTokenCounts(counts, `${path}.byModel.${model}`);
    if (error) return error;
  }
  return null;
}

export function validateMachineFile(data: unknown, filePath: string): MachineFile | null {
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
    if (!isRecord(providers)) {
      console.warn(`Skipping invalid machine file ${filePath}: days.${date} must be an object`);
      return null;
    }
    const providerDay: Record<string, ProviderDay> = {};
    for (const [providerKey, providerData] of Object.entries(providers)) {
      const error = validateProviderDay(providerData, `days.${date}.${providerKey}`);
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

export function parseMachineFile(raw: string, filePath: string): MachineFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping invalid machine file ${filePath}: invalid JSON (${message})`);
    return null;
  }
  return validateMachineFile(parsed, filePath);
}
