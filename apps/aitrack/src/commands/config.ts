import { invalidConfigMessage, readConfig, resolveMachineId, saveConfig } from 'aitrack-lib/config';
import type { Config } from 'aitrack-lib/configTypes';
import { NO_CONFIG_MESSAGE, REPO_URL_UNSET_MESSAGE } from 'aitrack-lib/data/messages';
import { migrateMachineDataFiles } from 'aitrack-lib/git';
import { normalizeMachineId } from 'aitrack-lib/machineId';
import { log } from 'aitrack-lib/output';
import { ENCRYPTION_PASSPHRASE_ENV, encryptionPassphrase } from 'aitrack-lib/store/encryption';
import chalk from 'chalk';

import { UsageError } from '../cli/errors.js';
import { printJsonCommand } from '../cli/json.js';

export const CONFIG_KEYS = [
  'repoUrl',
  'machineId',
  'claudeProjectsDir',
  'codexSessionsDir',
  'budget.monthly',
  'encryptData',
  'compactAfterDays',
] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function unknownKeyError(key: string): Error {
  return new UsageError(`Unknown config key: "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}.`);
}

function configValue(config: Config | null, key: ConfigKey): string | number | boolean | undefined {
  if (!config) return undefined;
  switch (key) {
    case 'repoUrl':
    case 'machineId':
    case 'claudeProjectsDir':
    case 'codexSessionsDir': {
      return config[key];
    }
    case 'budget.monthly': {
      return config.budget?.monthlyUSD;
    }
    case 'encryptData':
    case 'compactAfterDays': {
      return config[key];
    }
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unhandled config key: ${String(_exhaustive)}`);
    }
  }
}

function parseMonthlyBudget(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError('budget.monthly must be a positive dollar amount, e.g. 200 or 149.99.');
  }
  return parsed;
}

function parseEncryptData(value: string): boolean {
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error('encryptData must be true or false.');
}

/** Undefined for "off", which clears the setting. */
function parseCompactAfterDays(value: string): number | undefined {
  if (value === 'off') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('compactAfterDays must be a positive whole number of days, or "off".');
  }
  return parsed;
}

export interface ConfigCommandOptions {
  action: 'list' | 'get' | 'set';
  key?: string;
  value?: string;
  json?: boolean;
}

export function configCommand(options: ConfigCommandOptions): void {
  switch (options.action) {
    case 'list': {
      listConfig(options.json);
      break;
    }
    case 'get': {
      getConfig(options.key, options.json);
      break;
    }
    case 'set': {
      setConfig(options.key, options.value);
      break;
    }
    default: {
      const _exhaustive: never = options.action;
      throw new Error(`Unhandled config action: ${String(_exhaustive)}`);
    }
  }
}

/** Null when there is no config; an invalid one throws, so nothing here overwrites it. */
function existingConfig(): Config | null {
  const loaded = readConfig();
  if (loaded.status === 'invalid') throw new Error(invalidConfigMessage(loaded.reason));
  return loaded.status === 'ok' ? loaded.config : null;
}

function listConfig(json?: boolean): void {
  const config = existingConfig();
  if (json) {
    printJsonCommand('config', {
      action: 'list',
      values: Object.fromEntries(CONFIG_KEYS.map((key) => [key, configValue(config, key) ?? null])),
      resolvedMachineId: config ? resolveMachineId(config) : null,
      ...(!config && { message: NO_CONFIG_MESSAGE }),
    });
    return;
  }
  if (!config) {
    log.info(NO_CONFIG_MESSAGE);
    return;
  }
  log.info(chalk.bold('aitrack config'));
  for (const key of CONFIG_KEYS) {
    const value = configValue(config, key);
    log.info(`  ${key} = ${value === undefined ? chalk.dim('(unset)') : String(value)}`);
  }
  log.info(`  ${chalk.dim('resolved machineId')} = ${resolveMachineId(config)}`);
}

function getConfig(key: string | undefined, json?: boolean): void {
  if (key === undefined || !isConfigKey(key)) {
    throw unknownKeyError(key ?? '');
  }
  const value = configValue(existingConfig(), key);
  if (json) {
    printJsonCommand('config', { action: 'get', key, value: value ?? null });
    return;
  }
  if (value === undefined) {
    log.info('');
    return;
  }
  log.info(String(value));
}

function setConfig(key: string | undefined, value: string | undefined): void {
  if (key === undefined || !isConfigKey(key)) {
    throw unknownKeyError(key ?? '');
  }
  if (value === undefined) {
    throw new UsageError(`A value is required: aitrack config set ${key} <value>`);
  }
  const existing = existingConfig();
  const base: Config = existing ?? { repoUrl: '' };
  let next: Config;
  if (key === 'budget.monthly') {
    next = { ...base, budget: { ...base.budget, monthlyUSD: parseMonthlyBudget(value) } };
  } else if (key === 'encryptData') {
    next = { ...base, encryptData: parseEncryptData(value) };
    if (next.encryptData && encryptionPassphrase() === undefined) {
      log.warn(
        chalk.yellow(`${ENCRYPTION_PASSPHRASE_ENV} is not set; sync will fail until it is.`),
      );
    }
  } else if (key === 'compactAfterDays') {
    const { compactAfterDays: _previous, ...rest } = base;
    const days = parseCompactAfterDays(value);
    next = days === undefined ? rest : { ...rest, compactAfterDays: days };
  } else if (key === 'machineId') {
    const machineId = normalizeMachineId(value);
    migrateMachineDataFiles(resolveMachineId(existing), machineId);
    next = { ...base, machineId };
  } else {
    next = { ...base, [key]: value };
  }
  saveConfig(next);
  log.info(`Set ${key} = ${String(configValue(next, key))}`);
  if (next.repoUrl.length === 0) {
    log.warn(chalk.yellow(REPO_URL_UNSET_MESSAGE));
  }
}
