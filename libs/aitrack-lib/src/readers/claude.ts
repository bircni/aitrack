import { join } from 'node:path';

import { tryLoadConfig } from '../config.js';
import { addModelUsage, type Attribution, getOrCreateDay, mergeDayMaps } from '../data/dayMap.js';
import type { DayMap } from '../data/types.js';
import { environmentValue } from '../env.js';
import { estimateClaudeCostFromStoredCounts } from '../pricing/claude.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import type { CachedMessage, CachedParse } from './cache.js';
import { scanClaudeFile, type ScannedClaudeMessage } from './claudeScan.js';
import { claudeHomeDirs, resolveSourceRoots } from './paths.js';
import { parseProviderSources } from './pipeline.js';
import { attributeCwd, createProjectResolver, type ProjectResolver } from './projectResolver.js';

export function getClaudePaths(): string[] {
  return resolveSourceRoots({
    envValue: environmentValue('AITRACK_CLAUDE_PROJECTS_DIRS'),
    configValue: tryLoadConfig()?.claudeProjectsDir,
    defaults: claudeHomeDirs().map((dir) => join(dir, 'projects')),
  });
}

/** Price and attribute one file's scan into the view the cache stores. */
async function finishClaudeScan(
  scanned: ScannedClaudeMessage[],
  fallbacks?: FallbackCollector,
  resolveProject: ProjectResolver = createProjectResolver(),
): Promise<CachedParse> {
  const days: DayMap = new Map();
  const keys: string[] = [];
  const messages: CachedMessage[] = [];
  const attributions = new Map<string | undefined, Attribution>();
  for (const { key, date, model, counts, cwd } of scanned) {
    const costUSD = estimateClaudeCostFromStoredCounts(model, counts, date, fallbacks);
    if (costUSD !== undefined) counts.costUSD = costUSD;
    let attribution = attributions.get(cwd);
    if (attribution === undefined) {
      attribution = await attributeCwd(resolveProject, cwd);
      attributions.set(cwd, attribution);
    }
    const message: CachedMessage = {
      ...(key !== undefined && { key }),
      date,
      model,
      counts,
      ...attribution,
    };
    if (key !== undefined) keys.push(key);
    messages.push(message);
    addCachedMessage(days, message);
  }
  return { days, keys, messages };
}

/** Parse one transcript in isolation; the cache stores this per-file view. */
export async function parseClaudeFile(
  filePath: string,
  fallbacks?: FallbackCollector,
  resolveProject: ProjectResolver = createProjectResolver(),
): Promise<CachedParse> {
  return finishClaudeScan(await scanClaudeFile(filePath), fallbacks, resolveProject);
}

function addCachedMessage(result: DayMap, message: CachedMessage): void {
  const { project, cwd } = message;
  addModelUsage(getOrCreateDay(result, message.date), message.model, message.counts, {
    project,
    ...(cwd !== undefined && { cwd }),
  });
}

/** Keep the first file's contribution when resumed transcripts repeat a message. */
export function mergeClaudeParsed(parsed: CachedParse[]): DayMap {
  const allDays: DayMap = new Map();
  const seen = new Set<string>();
  for (const entry of parsed) {
    // One Set operation per key: this runs over every message on every read.
    let fresh: Set<string> | undefined;
    for (const [index, key] of entry.keys.entries()) {
      const size = seen.size;
      seen.add(key);
      if (seen.size === size) fresh ??= new Set(entry.keys.slice(0, index));
      else fresh?.add(key);
    }
    const messages = fresh && entry.messages;
    if (!messages) {
      mergeDayMaps(allDays, entry.days);
      continue;
    }
    for (const message of messages) {
      if (message.key === undefined || fresh?.delete(message.key))
        addCachedMessage(allDays, message);
    }
  }
  return allDays;
}

export async function readClaudeData(fallbacks?: FallbackCollector): Promise<DayMap> {
  const resolveProject = createProjectResolver();
  const parsed = await parseProviderSources({
    kind: 'claude',
    roots: getClaudePaths(),
    finish: (scanned) => finishClaudeScan(scanned, fallbacks, resolveProject),
  });
  return mergeClaudeParsed(parsed);
}
