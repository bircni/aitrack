import { homedir } from 'node:os';
import { join } from 'node:path';

import { tryLoadConfig } from '../config.js';
import { addModelUsage, getOrCreateDay, mergeDayMaps, tryLocalDateString } from '../data/dayMap.js';
import { stripModelAliasSuffix } from '../data/modelId.js';
import type { DayMap } from '../data/types.js';
import { environmentValue } from '../env.js';
import { claudeCacheWriteTokens, estimateClaudeCostUSD } from '../pricing/claude.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import type { CachedParse } from './cache.js';
import { streamJsonlObjects } from './jsonl.js';
import { resolveSourceRoots } from './paths.js';
import { parseProviderSources } from './pipeline.js';

export function getClaudePaths(): string[] {
  const xdg = environmentValue('XDG_CONFIG_HOME');
  return resolveSourceRoots({
    envValue: environmentValue('AITRACK_CLAUDE_PROJECTS_DIRS'),
    configValue: tryLoadConfig()?.claudeProjectsDir,
    defaults: [
      ...(xdg ? [join(xdg, 'claude', 'projects')] : []),
      join(homedir(), '.config', 'claude', 'projects'),
      join(homedir(), '.claude', 'projects'),
    ],
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

export async function parseJsonlFile(
  filePath: string,
  seen: Set<string>,
  fallbacks?: FallbackCollector,
): Promise<DayMap> {
  const result: DayMap = new Map();
  const chosen = new Map<string, CountedMessage>();
  const unkeyed: CountedMessage[] = [];

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
    // in this file (a later correction replaces a partial stream entry). Keys
    // already counted by an earlier file stay skipped so a resumed transcript
    // is not added twice.
    const key = `${entry.message?.id ?? ''}:${entry.requestId ?? ''}`;
    if (key === ':') {
      unkeyed.push(counted);
      continue;
    }
    if (seen.has(key)) continue;
    const existing = chosen.get(key);
    if (!existing || isRicherUsage(counted, existing)) chosen.set(key, counted);
  }

  for (const [key, counted] of chosen) {
    seen.add(key);
    addCountedMessage(result, counted);
  }
  for (const counted of unkeyed) addCountedMessage(result, counted);

  return result;
}

function addCountedMessage(result: DayMap, counted: CountedMessage): void {
  const day = getOrCreateDay(result, counted.dateString);
  addModelUsage(day, counted.model, {
    inputTokens: counted.inputTokens,
    outputTokens: counted.outputTokens,
    rawInputTokens: counted.rawInputTokens,
    cachedInputTokens: counted.cachedInputTokens,
    cacheCreationInputTokens: counted.cacheCreationInputTokens,
    ...(counted.cacheCreation1hInputTokens > 0 && {
      cacheCreation1hInputTokens: counted.cacheCreation1hInputTokens,
    }),
    ...(counted.costUSD !== undefined && { costUSD: counted.costUSD }),
  });
}

/**
 * Parse one transcript in isolation, collecting the dedup keys it holds.
 *
 * The per-file view is what the cache stores: it depends only on the file's own
 * bytes, unlike a parse threaded through the corpus-wide `seen` set. Passing a
 * fresh set both de-duplicates within the file and leaves the file's keys
 * behind for the cross-file check in readClaudeData.
 */
export async function parseClaudeFile(
  filePath: string,
  fallbacks?: FallbackCollector,
): Promise<CachedParse> {
  const keys = new Set<string>();
  const days = await parseJsonlFile(filePath, keys, fallbacks);
  return { days, keys: [...keys] };
}

/**
 * Fold the per-file parses into one DayMap, re-reading any file whose messages
 * an earlier file already counted (a resumed session copies another
 * transcript's history into itself, which the per-file parse cannot see).
 */
export async function mergeClaudeParsed(parsed: CachedParse[], files: string[]): Promise<DayMap> {
  const allDays: DayMap = new Map();
  const seenMessages = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const filePath = files[index];
    if (filePath !== undefined && entry.keys.some((key) => seenMessages.has(key))) {
      // Re-read this file against the running set, which is what an uncached
      // run would have done.
      mergeDayMaps(allDays, await parseJsonlFile(filePath, seenMessages));
      continue;
    }
    for (const key of entry.keys) seenMessages.add(key);
    mergeDayMaps(allDays, entry.days);
  }
  return allDays;
}

export async function readClaudeData(fallbacks?: FallbackCollector): Promise<DayMap> {
  const { files, parsed } = await parseProviderSources({
    cacheName: 'claude',
    roots: getClaudePaths(),
    parseFile: parseClaudeFile,
    fallbacks,
  });
  return mergeClaudeParsed(parsed, files);
}
