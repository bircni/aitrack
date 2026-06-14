import chalk from 'chalk';

import { resolveMachineId, saveConfig, tryLoadConfig } from '../config.js';
import type { Config } from '../data/types.js';

/** Configuration keys that can be read/written via the CLI. */
const CONFIG_KEYS = ['repoUrl', 'machineId'] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function unknownKeyError(key: string): Error {
  return new Error(`Unknown config key: "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}.`);
}

export interface ConfigCommandOptions {
  action: 'list' | 'get' | 'set';
  key?: string;
  value?: string;
}

// Async so any validation error surfaces as a rejected promise that the CLI's
// runAsync() wrapper can catch (a sync throw would escape it).
export async function configCommand(opts: ConfigCommandOptions): Promise<void> {
  await Promise.resolve();
  switch (opts.action) {
    case 'list': {
      listConfig();
      break;
    }
    case 'get': {
      getConfig(opts.key);
      break;
    }
    case 'set': {
      setConfig(opts.key, opts.value);
      break;
    }
  }
}

function listConfig(): void {
  const config = tryLoadConfig();
  if (!config) {
    console.log('No config found. Run: npx aitrack init');
    return;
  }
  console.log(chalk.bold('aitrack config'));
  for (const key of CONFIG_KEYS) {
    const value = config[key];
    console.log(`  ${key} = ${value ?? chalk.dim('(unset)')}`);
  }
  console.log(`  ${chalk.dim('resolved machineId')} = ${resolveMachineId(config)}`);
}

function getConfig(key: string | undefined): void {
  if (key === undefined || !isConfigKey(key)) {
    throw unknownKeyError(key ?? '');
  }
  const config = tryLoadConfig();
  const value = config?.[key];
  if (value === undefined) {
    console.log('');
    return;
  }
  console.log(value);
}

function setConfig(key: string | undefined, value: string | undefined): void {
  if (key === undefined || !isConfigKey(key)) {
    throw unknownKeyError(key ?? '');
  }
  if (value === undefined) {
    throw new Error(`A value is required: aitrack config set ${key} <value>`);
  }
  const existing = tryLoadConfig();
  const next: Config = { ...(existing ?? { repoUrl: '' }), [key]: value };
  saveConfig(next);
  console.log(`Set ${key} = ${value}`);
  if (next.repoUrl.length === 0) {
    console.warn(chalk.yellow('Warning: repoUrl is not set. Run: npx aitrack init'));
  }
}
