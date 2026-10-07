import { join } from 'node:path';

import { tryLoadConfig } from '../config.js';
import { addModelUsage, getOrCreateDay, mergeDayMaps, tryLocalDateString } from '../data/dayMap.js';
import { stripModelAliasSuffix } from '../data/modelId.js';
import type { DayMap } from '../data/types.js';
import { environmentValue } from '../env.js';
import { claudeCacheWriteTokens, estimateClaudeCostUSD } from '../pricing/claude.js';
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

interface CountedMessage {
  dateString: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  rawInputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens: number;
  costUSD?: number;
}

/** Prefer more output, then more input. A later record wins a tie. */
function isRicherUsage(next: CountedMessage, current: CountedMessage): boolean {
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
  const chosen = new Map<string, CountedMessage>();
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

    const writes = claudeCacheWriteTokens(usage);
    const inputTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      writes.fiveMinute +
      writes.oneHour;
    const outputTokens = usage.output_tokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0) continue;

    const model = stripModelAliasSuffix(entry.message?.model ?? 'unknown');
    const costUSD = estimateClaudeCostUSD(model, usage, dateString, fallbacks);
    const counted: CountedMessage = {
      dateString,
      model,
      inputTokens,
      outputTokens,
      rawInputTokens: usage.input_tokens ?? 0,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: writes.fiveMinute,
      cacheCreation1hInputTokens: writes.oneHour,
      ...(costUSD !== undefined && { costUSD }),
    };

    // No id to dedupe on: count the row. A known id keeps the fullest record
    // in this file (a later correction replaces a partial stream entry).
    const key = `${entry.message?.id ?? ''}:${entry.requestId ?? ''}`;
    if (key === ':') {
      addCachedMessage(unkeyed, cachedMessage(counted));
      continue;
    }
    const existing = chosen.get(key);
    if (!existing || isRicherUsage(counted, existing)) chosen.set(key, counted);
  }

  const messages: CachedMessage[] = [];
  for (const [key, counted] of chosen) {
    const message = cachedMessage(counted, key);
    messages.push(message);
    addCachedMessage(result, message);
  }
  mergeDayMaps(result, unkeyed);
  for (const [date, day] of unkeyed) {
    for (const [model, counts] of Object.entries(day.byModel))
      messages.push({ date, model, counts });
  }

  return { days: result, keys: [...chosen.keys()], messages };
}

function cachedMessage(counted: CountedMessage, key?: string): CachedMessage {
  return {
    key,
    date: counted.dateString,
    model: counted.model,
    counts: {
      inputTokens: counted.inputTokens,
      outputTokens: counted.outputTokens,
      rawInputTokens: counted.rawInputTokens,
      cachedInputTokens: counted.cachedInputTokens,
      cacheCreationInputTokens: counted.cacheCreationInputTokens,
      ...(counted.cacheCreation1hInputTokens > 0 && {
        cacheCreation1hInputTokens: counted.cacheCreation1hInputTokens,
      }),
      ...(counted.costUSD !== undefined && { costUSD: counted.costUSD }),
    },
  };
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
