import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import type { Config } from './data/types.js';

const CONFIG_DIR = join(homedir(), '.config', 'aitrack');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function loadConfig(): Config {
  const config = tryLoadConfig();
  if (!config) {
    throw new Error('No config found. Run: npx aitrack init');
  }
  return config;
}

export function tryLoadConfig(): Config | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('repoUrl' in parsed) ||
    typeof parsed.repoUrl !== 'string'
  ) {
    return null;
  }
  return parsed as Config;
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function resolveMachineId(config: Config): string {
  const id = config.machineId?.trim();
  return id && id.length > 0 ? id : hostname();
}
