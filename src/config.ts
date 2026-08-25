import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { MAX_PORT } from './constants.js';
import { isRecord } from './data/guards.js';
import { INIT_HINT, NO_CONFIG_MESSAGE } from './data/messages.js';
import type { Config } from './data/types.js';
import { errorMessage } from './errors.js';
import { normalizeMachineId } from './machineId.js';
import { APP_DIR, CONFIG_PATH } from './paths.js';

/**
 * Refresh interval ceiling in seconds. setInterval takes 32-bit milliseconds,
 * so a larger value overflows and Node silently clamps the timer to 1ms,
 * turning the daemon into a continuous refresh loop.
 */
export const MAX_INTERVAL_SECONDS = 2_147_483;

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
      value.port > MAX_PORT
    ) {
      return undefined;
    }
    daemon.port = value.port;
  }
  if (value.interval !== undefined) {
    if (
      typeof value.interval !== 'number' ||
      !Number.isSafeInteger(value.interval) ||
      value.interval < 1 ||
      value.interval > MAX_INTERVAL_SECONDS
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

/**
 * Outcome of reading the config file.
 *
 * `missing` and `invalid` used to collapse into the same `null`, so a config
 * that existed but was corrupt was reported as "No config found. Run: npx
 * aitrack init" — advice that would overwrite the very file the user needed to
 * fix, and that hid the real problem.
 */
export type ConfigLoad =
  | { status: 'ok'; config: Config }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

export function readConfig(): ConfigLoad {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return { status: 'missing' };
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

export function loadConfig(): Config {
  const loaded = readConfig();
  if (loaded.status === 'ok') return loaded.config;
  if (loaded.status === 'invalid') {
    throw new Error(`Config at ${CONFIG_PATH} is ${loaded.reason}. Fix it or re-run: ${INIT_HINT}`);
  }
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
