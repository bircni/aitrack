import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { tryLoadConfig } from '../config.js';
import { getOrCreateDay, mergeDayMaps, tryLocalDateString } from '../data/dayMap.js';
import { stripModelAliasSuffix } from '../data/modelId.js';
import type { DayMap, TokenCounts } from '../data/types.js';
import { estimateClaudeCostUSD } from '../pricing/claude.js';
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

export async function parseJsonlFile(filePath: string, seen: Set<string>): Promise<DayMap> {
  const result: DayMap = new Map();

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: ClaudeEntry;
    try {
      entry = JSON.parse(line) as ClaudeEntry;
    } catch {
      continue;
    }

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
    const costUSD = estimateClaudeCostUSD(model, usage, dateString);

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

export async function readClaudeData(): Promise<DayMap> {
  const files = await listUniqueSourceFiles(getClaudePaths());

  // seenMessages is shared across the parses so a message that a resumed
  // session copied into a second transcript is still counted once. Which copy
  // wins now depends on completion order rather than file order, but both are
  // arbitrary already (readdir order is not stable across platforms) and the
  // copies carry the same id, timestamp and usage.
  const seenMessages = new Set<string>();
  const parsed = await mapWithConcurrency(files, (file) => parseJsonlFile(file, seenMessages));

  const allDays: DayMap = new Map();
  for (const dayData of parsed) mergeDayMaps(allDays, dayData);
  return allDays;
}
