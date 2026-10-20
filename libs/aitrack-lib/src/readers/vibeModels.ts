import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'smol-toml';

import { writeFileAtomic } from '../atomicWrite.js';
import { isOptionalString, isRecord } from '../data/guards.js';
import { APP_DIR } from '../paths.js';
import { vibeHomeDir } from './paths.js';

/** Vibe's built-in default, used when `active_model` is unset (`""`). */
const VIBE_DEFAULT_MODEL_ALIAS = 'mistral-medium-3.5';

/** A Vibe model as configured: the alias Vibe shows and, when known, the API name it calls. */
export interface VibeModel {
  alias: string;
  name?: string;
}

export interface VibeConfig {
  activeModel?: string;
  /** Alias to API name. */
  models: Map<string, string>;
}

function isVibeModel(value: unknown): value is VibeModel {
  return isRecord(value) && typeof value.alias === 'string' && isOptionalString(value.name);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The user's `config.toml`; unreadable or malformed reads as Vibe's defaults. */
export function readVibeConfig(): VibeConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(readFileSync(join(vibeHomeDir(), 'config.toml'), 'utf8'));
  } catch {
    return { models: new Map() };
  }
  const models = new Map<string, string>();
  for (const entry of Array.isArray(parsed.models) ? parsed.models : []) {
    if (isRecord(entry) && typeof entry.alias === 'string' && typeof entry.name === 'string') {
      models.set(entry.alias, entry.name);
    }
  }
  const activeModel = parsed.active_model;
  return {
    models,
    ...(typeof activeModel === 'string' && activeModel !== '' && { activeModel }),
  };
}

/** `alias` and `activeModel` are never `""`: Vibe's unpinned value reads as undefined. */
export function configuredVibeModel(config: VibeConfig, alias?: string): VibeModel {
  const resolved = alias ?? config.activeModel ?? VIBE_DEFAULT_MODEL_ALIAS;
  const name = config.models.get(resolved);
  return { alias: resolved, ...(name !== undefined && { name }) };
}

export interface VibeModelLedger {
  /** The model first recorded for `sessionId`, recording `current()` when there is none. */
  resolve: (sessionId: string, current: () => VibeModel) => VibeModel;
  save: () => void;
}

/**
 * Unified sessions do not store an unpinned session's model, so the configured
 * default is fixed the first time a session is read; later config changes
 * then leave past sessions alone.
 */
export function openVibeModelLedger(path = join(APP_DIR, 'vibe-models.json')): VibeModelLedger {
  const load = (): Record<string, VibeModel> => {
    const value = readJson(path);
    if (!isRecord(value)) return {};
    const models: Record<string, VibeModel> = {};
    for (const [sessionId, model] of Object.entries(value)) {
      if (isVibeModel(model)) models[sessionId] = model;
    }
    return models;
  };
  const known = load();
  const added: Record<string, VibeModel> = {};

  return {
    resolve(sessionId, current) {
      const existing = known[sessionId] ?? added[sessionId];
      if (existing) return existing;
      const model = current();
      added[sessionId] = model;
      return model;
    },
    save() {
      if (Object.keys(added).length === 0) return;
      try {
        // Re-read so a concurrent CLI or app write is kept; the first recorded model wins.
        writeFileAtomic(path, JSON.stringify({ ...added, ...load() }));
      } catch {
        // Unsaved entries are recorded again on the next read.
      }
    },
  };
}
