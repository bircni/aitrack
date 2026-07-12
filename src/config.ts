import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import type { Config } from './data/types.js';
import { normalizeMachineId } from './machineId.js';

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
    if (
      typeof value.port !== 'number' ||
      !Number.isSafeInteger(value.port) ||
      value.port < 1 ||
      value.port > 65_535
    ) {
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

  const rawMachineId = optionalString(parsed.machineId);
  if (parsed.machineId !== undefined && rawMachineId === undefined) return null;
  let machineId: string | undefined;
  if (rawMachineId !== undefined) {
    try {
      machineId = normalizeMachineId(rawMachineId);
    } catch {
      return null;
    }
  }

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
  const normalized = {
    ...config,
    ...(config.machineId !== undefined && { machineId: normalizeMachineId(config.machineId) }),
  };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8');
}

// Use the short hostname, not the FQDN: the same machine reports different
// fully-qualified names depending on the network it is on (e.g. `host.local`
// at home vs `host.corp.example` on a VPN). Keying data files off the FQDN
// mints a fresh machine identity per network, and the old file keeps being
// counted as a separate machine — silently multiplying every total.
export function localMachineId(): string {
  const raw = hostname();
  const shortName = raw.split('.', 1)[0];
  return shortName && shortName.length > 0 ? shortName : raw;
}

export function resolveMachineId(config: Config): string {
  return normalizeMachineId(config.machineId ?? localMachineId());
}
