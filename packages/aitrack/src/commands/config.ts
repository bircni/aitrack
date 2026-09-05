import { resolveMachineId, saveConfig, tryLoadConfig } from 'aitrack-lib/config';
import type { Config } from 'aitrack-lib/configTypes';
import { MAX_PORT } from 'aitrack-lib/constants';
import { NO_CONFIG_MESSAGE, REPO_URL_UNSET_MESSAGE } from 'aitrack-lib/data/messages';
import { migrateMachineDataFiles } from 'aitrack-lib/git';
import { normalizeMachineId } from 'aitrack-lib/machineId';
import { log } from 'aitrack-lib/output';
import chalk from 'chalk';

/** Configuration keys that can be read/written via the CLI. */
export const CONFIG_KEYS = [
  'repoUrl',
  'machineId',
  'claudeProjectsDir',
  'codexSessionsDir',
  'daemon.port',
  'daemon.interval',
  'daemon.sync',
  'budget.monthly',
] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function unknownKeyError(key: string): Error {
  return new Error(`Unknown config key: "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}.`);
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
    case 'daemon.port': {
      return config.daemon?.port;
    }
    case 'daemon.interval': {
      return config.daemon?.interval;
    }
    case 'daemon.sync': {
      return config.daemon?.sync;
    }
    case 'budget.monthly': {
      return config.budget?.monthlyUSD;
    }
  }
}

function parseDaemonInteger(key: 'daemon.port' | 'daemon.interval', value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${key} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  if (key === 'daemon.port' && parsed > MAX_PORT) {
    throw new Error(`daemon.port must be between 1 and ${String(MAX_PORT)}.`);
  }
  return parsed;
}

function parseDaemonBoolean(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('daemon.sync must be either true or false.');
}

function parseMonthlyBudget(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('budget.monthly must be a positive dollar amount, e.g. 200 or 149.99.');
  }
  return parsed;
}

export interface ConfigCommandOptions {
  action: 'list' | 'get' | 'set';
  key?: string;
  value?: string;
}

// Async so any validation error surfaces as a rejected promise that the CLI's
// runAsync() wrapper can catch (a sync throw would escape it).
export async function configCommand(options: ConfigCommandOptions): Promise<void> {
  await Promise.resolve();
  switch (options.action) {
    case 'list': {
      listConfig();
      break;
    }
    case 'get': {
      getConfig(options.key);
      break;
    }
    case 'set': {
      setConfig(options.key, options.value);
      break;
    }
  }
}

function listConfig(): void {
  const config = tryLoadConfig();
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

function getConfig(key: string | undefined): void {
  if (key === undefined || !isConfigKey(key)) {
    throw unknownKeyError(key ?? '');
  }
  const config = tryLoadConfig();
  const value = configValue(config, key);
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
    throw new Error(`A value is required: aitrack config set ${key} <value>`);
  }
  const existing = tryLoadConfig();
  const normalizedValue =
    key === 'machineId'
      ? normalizeMachineId(value)
      : key === 'daemon.port' || key === 'daemon.interval'
        ? parseDaemonInteger(key, value)
        : key === 'daemon.sync'
          ? parseDaemonBoolean(value)
          : key === 'budget.monthly'
            ? parseMonthlyBudget(value)
            : value;
  if (key === 'machineId') {
    const previousMachineId = resolveMachineId(existing ?? { repoUrl: '' });
    migrateMachineDataFiles(previousMachineId, normalizeMachineId(value));
  }
  const base: Config = existing ?? { repoUrl: '' };
  const next: Config = key.startsWith('daemon.')
    ? {
        ...base,
        daemon: {
          ...base.daemon,
          [key.slice('daemon.'.length)]: normalizedValue,
        },
      }
    : key === 'budget.monthly'
      ? { ...base, budget: { ...base.budget, monthlyUSD: normalizedValue as number } }
      : { ...base, [key]: normalizedValue };
  saveConfig(next);
  log.info(`Set ${key} = ${String(normalizedValue)}`);
  if (next.repoUrl.length === 0) {
    log.warn(chalk.yellow(REPO_URL_UNSET_MESSAGE));
  }
}
