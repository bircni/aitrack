import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import type { Config } from './data/types.js';

const CONFIG_DIR = join(homedir(), '.config', 'aitrack');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : undefined;
}

function validateDaemon(value: unknown): Config['daemon'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const daemon: NonNullable<Config['daemon']> = {};
  if (value.sync !== undefined) {
    if (typeof value.sync !== 'boolean') return undefined;
    daemon.sync = value.sync;
  }
  if (value.port !== undefined) {
    if (typeof value.port !== 'number' || !Number.isSafeInteger(value.port) || value.port < 1) {
      return undefined;
    }
    daemon.port = value.port;
  }
  if (value.interval !== undefined) {
    if (
      typeof value.interval !== 'number' ||
      !Number.isSafeInteger(value.interval) ||
      value.interval < 1
    ) {
      return undefined;
    }
    daemon.interval = value.interval;
  }
  return daemon;
}

function validateConfig(parsed: unknown): Config | null {
  if (!isRecord(parsed)) return null;
  if (typeof parsed.repoUrl !== 'string') return null;

  const machineId = optionalString(parsed.machineId);
  if (parsed.machineId !== undefined && machineId === undefined) return null;

  const claudeProjectsDir = optionalString(parsed.claudeProjectsDir);
  if (parsed.claudeProjectsDir !== undefined && claudeProjectsDir === undefined) return null;

  const codexSessionsDir = optionalString(parsed.codexSessionsDir);
  if (parsed.codexSessionsDir !== undefined && codexSessionsDir === undefined) return null;

  const daemon = validateDaemon(parsed.daemon);
  if (parsed.daemon !== undefined && daemon === undefined) return null;

  return {
    repoUrl: parsed.repoUrl,
    ...(machineId !== undefined && { machineId }),
    ...(claudeProjectsDir !== undefined && { claudeProjectsDir }),
    ...(codexSessionsDir !== undefined && { codexSessionsDir }),
    ...(daemon !== undefined && { daemon }),
  };
}

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
  return validateConfig(parsed);
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function resolveMachineId(config: Config): string {
  const id = config.machineId?.trim();
  return id && id.length > 0 ? id : hostname();
}
