import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

import type { Config } from './configTypes.js';
import { isOptionalString, isRecord } from './data/guards.js';
import { INIT_HINT, NO_CONFIG_MESSAGE } from './data/messages.js';
import { errorMessage, isMissingPathError } from './errors.js';
import { normalizeMachineId } from './machineId.js';
import { APP_DIR, CONFIG_PATH } from './paths.js';

function validateBudget(value: unknown): Config['budget'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const budget: NonNullable<Config['budget']> = {};
  if (value.monthlyUSD !== undefined) {
    if (
      typeof value.monthlyUSD !== 'number' ||
      !Number.isFinite(value.monthlyUSD) ||
      value.monthlyUSD <= 0
    ) {
      return undefined;
    }
    budget.monthlyUSD = value.monthlyUSD;
  }
  return budget;
}

function validateConfig(parsed: unknown): Config | null {
  if (!isRecord(parsed)) return null;
  const { repoUrl, machineId: rawMachineId, claudeProjectsDir, codexSessionsDir } = parsed;
  if (
    typeof repoUrl !== 'string' ||
    !isOptionalString(rawMachineId) ||
    !isOptionalString(claudeProjectsDir) ||
    !isOptionalString(codexSessionsDir)
  ) {
    return null;
  }

  let machineId: string | undefined;
  if (rawMachineId !== undefined) {
    try {
      machineId = normalizeMachineId(rawMachineId);
    } catch {
      return null;
    }
  }

  const budget = validateBudget(parsed.budget);
  if (parsed.budget !== undefined && budget === undefined) return null;

  return {
    repoUrl,
    ...(machineId !== undefined && { machineId }),
    ...(claudeProjectsDir !== undefined && { claudeProjectsDir }),
    ...(codexSessionsDir !== undefined && { codexSessionsDir }),
    ...(budget !== undefined && { budget }),
  };
}

/** Outcome of reading the config file; `invalid` must not suggest `init`, which would overwrite it. */
export type ConfigLoad =
  | { status: 'ok'; config: Config }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

export function readConfig(): ConfigLoad {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) return { status: 'missing' };
    return { status: 'invalid', reason: `unreadable (${errorMessage(error)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: 'invalid', reason: `not valid JSON (${errorMessage(error)})` };
  }

  const config = validateConfig(parsed);
  if (!config) {
    return { status: 'invalid', reason: 'missing or malformed fields' };
  }
  return { status: 'ok', config };
}

/** Without the init hint, for `init` itself. */
export function describeInvalidConfig(reason: string): string {
  return `Config at ${CONFIG_PATH} is ${reason}.`;
}

export function invalidConfigMessage(reason: string): string {
  return `${describeInvalidConfig(reason)} Fix it or re-run: ${INIT_HINT}`;
}

export function loadConfig(): Config {
  const loaded = readConfig();
  if (loaded.status === 'ok') return loaded.config;
  if (loaded.status === 'invalid') throw new Error(invalidConfigMessage(loaded.reason));
  throw new Error(NO_CONFIG_MESSAGE);
}

export function tryLoadConfig(): Config | null {
  const loaded = readConfig();
  return loaded.status === 'ok' ? loaded.config : null;
}

export function saveConfig(config: Config): void {
  const normalized = {
    ...config,
    ...(config.machineId !== undefined && { machineId: normalizeMachineId(config.machineId) }),
  };
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8');
}

// Short hostname: the FQDN changes per network and would fork the machine's identity.
export function localMachineId(): string {
  const raw = hostname();
  const shortName = raw.split('.', 1)[0];
  return shortName && shortName.length > 0 ? shortName : raw;
}

export function resolveMachineId(config: Pick<Config, 'machineId'> | null): string {
  return normalizeMachineId(config?.machineId ?? localMachineId());
}
