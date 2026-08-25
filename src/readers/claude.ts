import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { tryLoadConfig } from '../config.js';
import { getOrCreateDay, mergeDayMaps, tryLocalDateString } from '../data/dayMap.js';
import { isRecord } from '../data/guards.js';
import { stripModelAliasSuffix } from '../data/modelId.js';
import type { DayMap, TokenCounts } from '../data/types.js';
import { estimateClaudeCostUSD } from '../pricing/claude.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import { type CachedParse, openParseCache } from './cache.js';
import { mapWithConcurrency } from './concurrency.js';
import { listUniqueSourceFiles, resolveSourceRoots } from './paths.js';

export function getClaudePaths(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME;
  return resolveSourceRoots({
    envValue: process.env.AITRACK_CLAUDE_PROJECTS_DIRS,
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
    };
  };
}

function addClaudeUsageBreakdown(
  rec: TokenCounts,
  usage: NonNullable<NonNullable<ClaudeEntry['message']>['usage']>,
): void {
  const raw = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  rec.rawInputTokens = (rec.rawInputTokens ?? 0) + raw;
  rec.cachedInputTokens = (rec.cachedInputTokens ?? 0) + cacheRead;
  rec.cacheCreationInputTokens = (rec.cacheCreationInputTokens ?? 0) + cacheCreate;
}

export async function parseJsonlFile(
  filePath: string,
  seen: Set<string>,
  fallbacks?: FallbackCollector,
): Promise<DayMap> {
  const result: DayMap = new Map();

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated or half-written line — the transcript is appended to while
      // it is being read. Skip it rather than failing the whole file.
      continue;
    }
    // A JSONL line is only interesting when it is an object; a bare number or
    // string parses fine and would otherwise be cast to a shape it never had.
    if (!isRecord(parsed)) continue;
    const entry = parsed as unknown as ClaudeEntry;

    if (entry.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    if ((usage.output_tokens ?? 0) === 0) continue;

    const key = `${entry.message?.id ?? ''}:${entry.requestId ?? ''}`;
    if (key !== ':' && seen.has(key)) continue;
    if (key !== ':') seen.add(key);

    const ts = entry.timestamp;
    if (!ts) continue;
    const dateString = tryLocalDateString(ts);
    if (dateString === null) continue;
    const model = stripModelAliasSuffix(entry.message?.model ?? 'unknown');

    const inputTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    const outputTokens = usage.output_tokens ?? 0;
    const costUSD = estimateClaudeCostUSD(model, usage, dateString, fallbacks);

    const day = getOrCreateDay(result, dateString);
    const rec = (day.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
    rec.inputTokens += inputTokens;
    rec.outputTokens += outputTokens;
    addClaudeUsageBreakdown(rec, usage);
    rec.costUSD = (rec.costUSD ?? 0) + costUSD;
    day.inputTokens += inputTokens;
    day.outputTokens += outputTokens;
    addClaudeUsageBreakdown(day, usage);
    day.costUSD = (day.costUSD ?? 0) + costUSD;
  }

  return result;
}

/**
 * Parse one transcript in isolation, collecting the dedup keys it holds.
 *
 * The per-file view is what the cache stores: it depends only on the file's own
 * bytes, unlike a parse threaded through the corpus-wide `seen` set. Passing a
 * fresh set both de-duplicates within the file and leaves the file's keys
 * behind for the cross-file check in readClaudeData.
 */
async function parseClaudeFile(
  filePath: string,
  fallbacks?: FallbackCollector,
): Promise<CachedParse> {
  const keys = new Set<string>();
  const days = await parseJsonlFile(filePath, keys, fallbacks);
  return { days, keys: [...keys] };
}

export async function readClaudeData(fallbacks?: FallbackCollector): Promise<DayMap> {
  const files = await listUniqueSourceFiles(getClaudePaths());
  const cache = openParseCache('claude');

  const parsed = await mapWithConcurrency(files, async (filePath) => {
    const cached = await cache.lookup(filePath);
    if (cached) return cached;
    const fresh = await parseClaudeFile(filePath, fallbacks);
    await cache.record(filePath, fresh);
    return fresh;
  });
  cache.save();

  const allDays: DayMap = new Map();
  const seenMessages = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const filePath = files[index];
    if (filePath !== undefined && entry.keys.some((key) => seenMessages.has(key))) {
      // A message in this file was already counted from an earlier one — a
      // resumed session copied another transcript's history into itself. The
      // per-file parse cannot know that, so re-read this file against the
      // running set, which is what an uncached run would have done.
      mergeDayMaps(allDays, await parseJsonlFile(filePath, seenMessages));
      continue;
    }
    for (const key of entry.keys) seenMessages.add(key);
    mergeDayMaps(allDays, entry.days);
  }
  return allDays;
}
