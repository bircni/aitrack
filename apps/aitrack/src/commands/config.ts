import { invalidConfigMessage, readConfig, resolveMachineId, saveConfig } from 'aitrack-lib/config';
import type { Config } from 'aitrack-lib/configTypes';
import { NO_CONFIG_MESSAGE, REPO_URL_UNSET_MESSAGE } from 'aitrack-lib/data/messages';
import { parsePositiveInteger } from 'aitrack-lib/data/usagePeriods';
import { errorMessage } from 'aitrack-lib/errors';
import { LOCAL_REPO, migrateMachineDataFiles } from 'aitrack-lib/git';
import { differingOrigin, redactUrl } from 'aitrack-lib/git/remote';
import { normalizeMachineId } from 'aitrack-lib/machineId';
import { log } from 'aitrack-lib/output';
import { ENCRYPTION_PASSPHRASE_ENV, encryptionPassphrase } from 'aitrack-lib/store/encryption';
import chalk from 'chalk';

import { UsageError } from '../cli/errors.js';
import { printJsonCommand } from '../cli/json.js';
import { CONFIG_KEYS } from './configKeys.js';

type ConfigKey = (typeof CONFIG_KEYS)[number];

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function unknownKeyError(key: string): Error {
  return new UsageError(`Unknown config key: "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}.`);
}

function configValue(config: Config | null, key: ConfigKey): string | number | boolean | undefined {
  return key === 'budget.monthly' ? config?.budget?.monthlyUSD : config?.[key];
}

/** What `list` and the `set` echo show; `get` prints the stored value, since asking for it is explicit. */
function displayValue(key: ConfigKey, value: string | number | boolean): string {
  return key === 'repoUrl' ? redactUrl(String(value)) : String(value);
}

/** Undefined for "off", which clears the setting. */
function parseMonthlyBudget(value: string): number | undefined {
  if (value === 'off') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(
      'budget.monthly must be a positive dollar amount, e.g. 200 or 149.99, or "off".',
    );
  }
  return parsed;
}

function parseEncryptData(value: string): boolean {
  if (value === 'true' || value === 'false') return value === 'true';
  throw new UsageError('encryptData must be true or false.');
}

/** Undefined for "off", which clears the setting. */
function parseCompactAfterDays(value: string): number | undefined {
  if (value === 'off') return undefined;
  const parsed = parsePositiveInteger(value);
  if (parsed === null) {
    throw new UsageError('compactAfterDays must be a positive whole number of days, or "off".');
  }
  return parsed;
}

function parseMachineId(value: string): string {
  try {
    return normalizeMachineId(value);
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

/** Moving the remote replaces the clone, which needs init's confirmation; saying so here beats a sync that keeps pushing to the old one. */
function assertRepoUrlFitsClone(repoUrl: string): void {
  const origin = differingOrigin(repoUrl);
  if (origin === null) return;
  throw new UsageError(
    `repoUrl not changed: the local clone at ${LOCAL_REPO} pushes to ${redactUrl(origin)}. ` +
      `To replace the clone, run: aitrack init --repo <url> (asks first). ` +
      `To keep its history and move it to the new remote, run: git -C "${LOCAL_REPO}" remote set-url origin <url>, then set repoUrl again.`,
  );
}

/** Null when there is no config; an invalid one throws, so nothing here overwrites it. */
function existingConfig(): Config | null {
  const loaded = readConfig();
  if (loaded.status === 'invalid') throw new Error(invalidConfigMessage(loaded.reason));
  return loaded.status === 'ok' ? loaded.config : null;
}

export function listConfig(json?: boolean): void {
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
    log.info(`  ${key} = ${value === undefined ? chalk.dim('(unset)') : displayValue(key, value)}`);
  }
  log.info(`  ${chalk.dim('resolved machineId')} = ${resolveMachineId(config)}`);
}

export function getConfig(key: string, json?: boolean): void {
  if (!isConfigKey(key)) throw unknownKeyError(key);
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

export function setConfig(key: string, value: string): void {
  if (!isConfigKey(key)) throw unknownKeyError(key);
  const existing = existingConfig();
  const base: Config = existing ?? { repoUrl: '' };
  let next: Config;
  if (key === 'budget.monthly') {
    const { budget, ...rest } = base;
    const monthlyUSD = parseMonthlyBudget(value);
    next = monthlyUSD === undefined ? rest : { ...rest, budget: { ...budget, monthlyUSD } };
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
    const machineId = parseMachineId(value);
    migrateMachineDataFiles(resolveMachineId(existing), machineId);
    next = { ...base, machineId };
  } else {
    if (key === 'repoUrl') assertRepoUrlFitsClone(value);
    next = { ...base, [key]: value };
  }
  saveConfig(next);
  const saved = configValue(next, key);
  log.info(saved === undefined ? `Cleared ${key}.` : `Set ${key} = ${displayValue(key, saved)}`);
  if (next.repoUrl.length === 0) {
    log.warn(chalk.yellow(REPO_URL_UNSET_MESSAGE));
  }
}
