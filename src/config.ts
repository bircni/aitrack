import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import type { Config } from './types.js';

const CONFIG_DIR = join(homedir(), '.config', 'aitrack');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as Config;
  } catch {
    throw new Error('No config found. Run: npx aitrack init');
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function resolveMachineId(config: Config): string {
  const id = config.machineId?.trim();
  return id && id.length > 0 ? id : hostname();
}
