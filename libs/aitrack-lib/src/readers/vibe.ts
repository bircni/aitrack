import { existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { addModelUsage, getOrCreateDay, mergeDayMaps, tryLocalDateString } from '../data/dayMap.js';
import { isFiniteNumber, isRecord } from '../data/guards.js';
import { stripModelAliasSuffix } from '../data/modelId.js';
import type { DayMap } from '../data/types.js';
import { environmentValue } from '../env.js';
import { isMissingPathError } from '../errors.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import { estimateMistralCostUSD, hasMistralPricing } from '../pricing/mistral.js';
import type { CachedParse } from './cache.js';
import { resolveSourceRoots, vibeHomeDir } from './paths.js';
import { parseProviderSources } from './pipeline.js';
import { attributeCwd, createProjectResolver, type ProjectResolver } from './projectResolver.js';
import {
  configuredVibeModel,
  openVibeModelLedger,
  readVibeConfig,
  type VibeConfig,
  type VibeModel,
  type VibeModelLedger,
} from './vibeModels.js';

export function getVibePaths(config: VibeConfig = readVibeConfig()): string[] {
  return resolveSourceRoots({
    envValue: environmentValue('AITRACK_VIBE_SESSION_DIRS'),
    defaults: [config.sessionDir ?? join(vibeHomeDir(), 'logs', 'session')],
  });
}

async function directoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

/** One file per session: a legacy session's `meta.json` or a unified store's `CURRENT` pointer. */
export async function listVibeSessionFiles(
  roots: string[],
  prefix = readVibeConfig().sessionPrefix,
): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const root of roots) {
    const identity = await realpath(root).catch(() => root);
    if (seen.has(identity)) continue; // Overlapping roots would double a session's tokens.
    seen.add(identity);
    const names = await directoryNames(root);
    const unified = names.includes('unified') ? await directoryNames(join(root, 'unified')) : [];
    const candidates = [
      ...names
        .filter((name) => name.startsWith(`${prefix}_`))
        .map((name) => join(root, name, 'meta.json')),
      ...unified.map((name) => join(root, 'unified', name, 'CURRENT')),
    ];
    files.push(...candidates.filter((file) => existsSync(file)));
  }
  return files;
}

interface VibeSession {
  date: string | null;
  model: VibeModel;
  cwd?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

function count(value: unknown): number {
  return isFiniteNumber(value) && value > 0 ? value : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  return isRecord(value) ? value : {};
}

/** Pre-2.26 sessions: `meta.json` holds session totals and a snapshot of the config they ran with. */
function legacySession(meta: Record<string, unknown>): VibeSession {
  const stats = isRecord(meta.stats) ? meta.stats : {};
  const config = isRecord(meta.config) ? meta.config : {};
  const models = new Map<string, string>();
  for (const [alias, entry] of Object.entries(isRecord(config.models) ? config.models : {})) {
    if (isRecord(entry) && typeof entry.name === 'string') models.set(alias, entry.name);
  }
  const environment = isRecord(meta.environment) ? meta.environment : {};
  const cwd = text(environment.working_directory) ?? text(meta.origin_directory);
  const end = text(meta.end_time) ?? text(meta.start_time);
  return {
    date: end === undefined ? null : tryLocalDateString(end),
    model: configuredVibeModel(
      { models },
      text(config.active_model) ?? text(config.routed_default_model),
    ),
    ...(cwd !== undefined && { cwd }),
    inputTokens: count(stats.session_prompt_tokens),
    outputTokens: count(stats.session_completion_tokens),
    cachedInputTokens: count(stats.session_cached_tokens),
  };
}

/** Vibe 2.26+ sessions: `CURRENT` names the latest snapshot generation. */
async function unifiedSession(
  currentPath: string,
  config: VibeConfig,
  ledger: VibeModelLedger,
): Promise<VibeSession | null> {
  const current = await readJson(currentPath);
  const generation = current.generation;
  if (typeof generation !== 'string' || !/^\d+$/u.test(generation)) return null;
  const dir = join(dirname(currentPath), 'generations', generation);
  const [projection, runtime] = await Promise.all([
    readJson(join(dir, 'projection-state.json')),
    readJson(join(dir, 'runtime-state.json')).catch((): Record<string, unknown> => ({})),
  ]);
  const snapshot = isRecord(projection.snapshot) ? projection.snapshot : {};
  const session = isRecord(snapshot.session) ? snapshot.session : {};
  const usage = isRecord(session.tokenUsage) ? session.tokenUsage : {};
  const metadata = isRecord(runtime.session_metadata) ? runtime.session_metadata : {};
  const pinned = text(metadata.active_model);
  const sessionId = text(current.session_id) ?? basename(dirname(currentPath));
  const updatedAt = isFiniteNumber(session.updatedAt) ? new Date(session.updatedAt) : undefined;
  const cwd = text(metadata.cwd);
  return {
    date: updatedAt === undefined ? null : tryLocalDateString(updatedAt),
    model:
      pinned === undefined
        ? ledger.resolve(sessionId, () => configuredVibeModel(config))
        : configuredVibeModel(config, pinned),
    ...(cwd !== undefined && { cwd }),
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cachedInputTokens: count(usage.cachedInputTokens),
  };
}

/** The priced id: the API name when it has a rate (`mistral-large-4`), else the alias. */
function vibeModelId(model: VibeModel): string {
  const name = model.name === undefined ? undefined : stripModelAliasSuffix(model.name);
  return name !== undefined && hasMistralPricing(name) ? name : stripModelAliasSuffix(model.alias);
}

async function parseVibeFile(
  filePath: string,
  options: {
    fallbacks: FallbackCollector | undefined;
    resolveProject: ProjectResolver;
    config: VibeConfig;
    ledger: VibeModelLedger;
  },
): Promise<CachedParse> {
  const days: DayMap = new Map();
  const session = await (
    basename(filePath) === 'meta.json'
      ? readJson(filePath).then(legacySession)
      : unifiedSession(filePath, options.config, options.ledger)
  ).catch(() => null); // Mid-write or unreadable; a rewrite changes the stamp and re-parses.
  if (!session?.date || session.inputTokens + session.outputTokens === 0) return { days, keys: [] };

  const { inputTokens, outputTokens, cachedInputTokens } = session;
  const model = vibeModelId(session.model);
  const cost = estimateMistralCostUSD(
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    options.fallbacks,
  );
  addModelUsage(
    getOrCreateDay(days, session.date),
    model,
    {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      ...(cost !== undefined && { costUSD: cost }),
    },
    await attributeCwd(options.resolveProject, session.cwd),
  );
  return { days, keys: [] };
}

export async function readVibeData(fallbacks?: FallbackCollector): Promise<DayMap> {
  const resolveProject = createProjectResolver();
  const config = readVibeConfig();
  const ledger = openVibeModelLedger();
  const parsed = await parseProviderSources({
    cacheName: 'vibe',
    roots: getVibePaths(config),
    listFiles: (roots) => listVibeSessionFiles(roots, config.sessionPrefix),
    parseFile: (filePath, collector) =>
      parseVibeFile(filePath, { fallbacks: collector, resolveProject, config, ledger }),
    fallbacks,
  });
  ledger.save();

  const allDays: DayMap = new Map();
  for (const entry of parsed) mergeDayMaps(allDays, entry.days);
  return allDays;
}
