import { join } from 'node:path';

import { tryLoadConfig } from '../config.js';
import { addModelUsage, getOrCreateDay, mergeDayMaps, tryLocalDateString } from '../data/dayMap.js';
import { stripModelAliasSuffix } from '../data/modelId.js';
import type { DayMap, TokenCounts } from '../data/types.js';
import { environmentValue } from '../env.js';
import { claudeUsageCounts, estimateClaudeCostFromStoredCounts } from '../pricing/claude.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import type { CachedMessage, CachedParse } from './cache.js';
import { streamJsonlObjects } from './jsonl.js';
import { claudeHomeDirs, resolveSourceRoots } from './paths.js';
import { parseProviderSources } from './pipeline.js';

export function getClaudePaths(): string[] {
  return resolveSourceRoots({
    envValue: environmentValue('AITRACK_CLAUDE_PROJECTS_DIRS'),
    configValue: tryLoadConfig()?.claudeProjectsDir,
    defaults: claudeHomeDirs().map((dir) => join(dir, 'projects')),
  });
}

interface ClaudeEntry {
  type: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

/** Prefer more output, then more input. A later record wins a tie. */
function isRicherUsage(next: TokenCounts, current: TokenCounts): boolean {
  if (next.outputTokens !== current.outputTokens) return next.outputTokens > current.outputTokens;
  if (next.inputTokens !== current.inputTokens) return next.inputTokens > current.inputTokens;
  return true;
}

/** Parse one transcript in isolation; the cache stores this per-file view. */
export async function parseClaudeFile(
  filePath: string,
  fallbacks?: FallbackCollector,
): Promise<CachedParse> {
  const result: DayMap = new Map();
  const chosen = new Map<string, CachedMessage>();
  const unkeyed: DayMap = new Map();

  for await (const parsed of streamJsonlObjects(filePath)) {
    const entry = parsed as unknown as ClaudeEntry;

    if (entry.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    if (!usage) continue;

    const ts = entry.timestamp;
    if (!ts) continue;
    const dateString = tryLocalDateString(ts);
    if (dateString === null) continue;

    const counts = claudeUsageCounts(usage);
    if (counts.inputTokens === 0 && counts.outputTokens === 0) continue;

    const model = stripModelAliasSuffix(entry.message?.model ?? 'unknown');
    const costUSD = estimateClaudeCostFromStoredCounts(model, counts, dateString, fallbacks);
    if (costUSD !== undefined) counts.costUSD = costUSD;

    // No id to dedupe on: count the row. A known id keeps the fullest record
    // in this file (a later correction replaces a partial stream entry).
    const key = `${entry.message?.id ?? ''}:${entry.requestId ?? ''}`;
    if (key === ':') {
      addCachedMessage(unkeyed, { date: dateString, model, counts });
      continue;
    }
    const existing = chosen.get(key);
    if (!existing || isRicherUsage(counts, existing.counts)) {
      chosen.set(key, { key, date: dateString, model, counts });
    }
  }

  const messages = [...chosen.values()];
  for (const message of messages) addCachedMessage(result, message);
  mergeDayMaps(result, unkeyed);
  for (const [date, day] of unkeyed) {
    for (const [model, counts] of Object.entries(day.byModel))
      messages.push({ date, model, counts });
  }

  return { days: result, keys: [...chosen.keys()], messages };
}

function addCachedMessage(result: DayMap, message: CachedMessage): void {
  addModelUsage(getOrCreateDay(result, message.date), message.model, message.counts);
}

/** Keep the first file's contribution when resumed transcripts repeat a message. */
export function mergeClaudeParsed(parsed: CachedParse[]): DayMap {
  const allDays: DayMap = new Map();
  const seenMessages = new Set<string>();
  for (const entry of parsed) {
    if (!entry.messages || !entry.keys.some((key) => seenMessages.has(key))) {
      for (const key of entry.keys) seenMessages.add(key);
      mergeDayMaps(allDays, entry.days);
      continue;
    }
    for (const message of entry.messages) {
      if (message.key !== undefined && seenMessages.has(message.key)) continue;
      if (message.key !== undefined) seenMessages.add(message.key);
      addCachedMessage(allDays, message);
    }
  }
  return allDays;
}

export async function readClaudeData(fallbacks?: FallbackCollector): Promise<DayMap> {
  const parsed = await parseProviderSources({
    cacheName: 'claude',
    roots: getClaudePaths(),
    parseFile: parseClaudeFile,
    fallbacks,
  });
  return mergeClaudeParsed(parsed);
}
