import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { getOrCreateDay, toLocalDateString } from '../data/dayMap.js';
import type { DayMap, TokenCounts } from '../data/types.js';
import { findClaudePricing } from '../pricing/claude.js';

function getClaudePaths(): string[] {
  const paths = new Set<string>();
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) paths.add(join(xdg, 'claude', 'projects'));
  paths.add(join(homedir(), '.config', 'claude', 'projects'));
  paths.add(join(homedir(), '.claude', 'projects'));
  return [...paths].map((p) => resolve(p));
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  await walk(dir);
  return files;
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

export function estimateClaudeCostUSD(
  model: string,
  usage: NonNullable<NonNullable<ClaudeEntry['message']>['usage']>,
  usageDate?: string,
): number {
  const pricing = findClaudePricing(model, usageDate);
  return (
    ((usage.input_tokens ?? 0) * pricing.inputPerMillion +
      (usage.output_tokens ?? 0) * pricing.outputPerMillion +
      (usage.cache_read_input_tokens ?? 0) * pricing.cacheReadPerMillion +
      (usage.cache_creation_input_tokens ?? 0) * pricing.cacheCreatePerMillion) /
    1_000_000
  );
}

// Backfill estimator for synced rows that lack a costUSD value (older data).
// The cache vs raw-input split has already been collapsed into a single
// inputTokens number, so we apply full input pricing — an upper bound.
export function estimateClaudeCostFromAggregateTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  usageDate?: string,
): number {
  const pricing = findClaudePricing(model, usageDate);
  return (
    (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000
  );
}

export function claudeCountsHaveCostBreakdown(counts: TokenCounts): boolean {
  return (
    counts.rawInputTokens !== undefined ||
    counts.cachedInputTokens !== undefined ||
    counts.cacheCreationInputTokens !== undefined
  );
}

export function estimateClaudeCostFromStoredCounts(
  model: string,
  counts: TokenCounts,
  usageDate?: string,
): number | undefined {
  if (!claudeCountsHaveCostBreakdown(counts)) return undefined;
  const pricing = findClaudePricing(model, usageDate);
  const cacheRead = counts.cachedInputTokens ?? 0;
  const cacheCreate = counts.cacheCreationInputTokens ?? 0;
  const raw = counts.rawInputTokens ?? Math.max(0, counts.inputTokens - cacheRead - cacheCreate);
  return (
    (raw * pricing.inputPerMillion +
      counts.outputTokens * pricing.outputPerMillion +
      cacheRead * pricing.cacheReadPerMillion +
      cacheCreate * pricing.cacheCreatePerMillion) /
    1_000_000
  );
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

function mergeTokenBreakdown(dst: TokenCounts, src: TokenCounts): void {
  if (src.rawInputTokens !== undefined) {
    dst.rawInputTokens = (dst.rawInputTokens ?? 0) + src.rawInputTokens;
  }
  if (src.cachedInputTokens !== undefined) {
    dst.cachedInputTokens = (dst.cachedInputTokens ?? 0) + src.cachedInputTokens;
  }
  if (src.cacheCreationInputTokens !== undefined) {
    dst.cacheCreationInputTokens =
      (dst.cacheCreationInputTokens ?? 0) + src.cacheCreationInputTokens;
  }
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
    const dateStr = toLocalDateString(ts);
    const model = (entry.message?.model ?? 'unknown').replace(/-latest$/, '');

    const inputTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    const outputTokens = usage.output_tokens ?? 0;
    const costUSD = estimateClaudeCostUSD(model, usage, dateStr);

    const day = getOrCreateDay(result, dateStr);
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

function mergeDayMaps(dst: DayMap, src: DayMap): void {
  for (const [date, srcDay] of src) {
    const dstDay = getOrCreateDay(dst, date);
    dstDay.inputTokens += srcDay.inputTokens;
    dstDay.outputTokens += srcDay.outputTokens;
    mergeTokenBreakdown(dstDay, srcDay);
    if (srcDay.costUSD !== undefined) dstDay.costUSD = (dstDay.costUSD ?? 0) + srcDay.costUSD;
    for (const [model, counts] of Object.entries(srcDay.byModel)) {
      const modelTotals = (dstDay.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
      modelTotals.inputTokens += counts.inputTokens;
      modelTotals.outputTokens += counts.outputTokens;
      mergeTokenBreakdown(modelTotals, counts);
      if (counts.costUSD !== undefined) {
        modelTotals.costUSD = (modelTotals.costUSD ?? 0) + counts.costUSD;
      }
    }
  }
}

export async function readClaudeData(): Promise<DayMap> {
  const roots = getClaudePaths();
  const seenPaths = new Set<string>();
  const seenMessages = new Set<string>();
  const allDays: DayMap = new Map();

  for (const root of roots) {
    const files = await findJsonlFiles(root);
    for (const file of files) {
      const resolved = resolve(file);
      if (seenPaths.has(resolved)) continue;
      seenPaths.add(resolved);
      const dayData = await parseJsonlFile(resolved, seenMessages);
      mergeDayMaps(allDays, dayData);
    }
  }

  return allDays;
}

export { findClaudePricing as findPricing } from '../pricing/claude.js';
