import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { tryLoadConfig } from '../config.js';
import { getOrCreateDay, tryLocalDateString } from '../data/dayMap.js';
import type { DayMap } from '../data/types.js';
import { estimateCodexCostUSD } from '../pricing/codex.js';
import { listJsonlFiles, resolveSourceRoots } from './paths.js';

export function getCodexPaths(): string[] {
  const codexHome = process.env.CODEX_HOME;
  return resolveSourceRoots({
    envValue: process.env.AITRACK_CODEX_SESSION_DIRS,
    configValue: tryLoadConfig()?.codexSessionsDir,
    defaults: [
      ...(codexHome ? [join(codexHome, 'sessions')] : []),
      join(homedir(), '.codex', 'sessions'),
    ],
  });
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexEntry {
  type: string;
  timestamp?: string;
  payload?: {
    type?: string;
    model?: string;
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
    };
  };
}

interface SessionResult {
  dateStr: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

function tokenUsageValues(usage: TokenUsage): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
  };
}

function addSessionUsage(
  results: Map<string, SessionResult>,
  dateStr: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): void {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
  const key = `${dateStr}\0${model}`;
  const result = results.get(key) ?? {
    dateStr,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  result.inputTokens += usage.inputTokens;
  result.outputTokens += usage.outputTokens;
  result.cachedInputTokens += usage.cachedInputTokens;
  results.set(key, result);
}

export async function parseSessionFile(filePath: string): Promise<SessionResult[]> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let currentDate: string | null = null;
  let model = 'unknown';
  let previousTotal = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  const results = new Map<string, SessionResult>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line) as CodexEntry;
    } catch {
      continue;
    }

    if (entry.timestamp) {
      currentDate = tryLocalDateString(entry.timestamp) ?? currentDate;
    }

    if (entry.type === 'turn_context' && entry.payload?.model) {
      model = entry.payload.model;
    }

    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;

    const info = entry.payload.info;
    if (!info) continue;

    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null =
      null;
    if (info.total_token_usage) {
      const current = info.total_token_usage;
      const isRolledBack =
        (current.input_tokens ?? 0) < previousTotal.input_tokens ||
        (current.output_tokens ?? 0) < previousTotal.output_tokens ||
        (current.cached_input_tokens ?? 0) < previousTotal.cached_input_tokens;

      if (isRolledBack) {
        usage = tokenUsageValues(info.last_token_usage ?? current);
      } else {
        usage = {
          inputTokens: Math.max(0, (current.input_tokens ?? 0) - previousTotal.input_tokens),
          outputTokens: Math.max(0, (current.output_tokens ?? 0) - previousTotal.output_tokens),
          cachedInputTokens: Math.max(
            0,
            (current.cached_input_tokens ?? 0) - previousTotal.cached_input_tokens,
          ),
        };
      }
      previousTotal = {
        input_tokens: current.input_tokens ?? 0,
        output_tokens: current.output_tokens ?? 0,
        cached_input_tokens: current.cached_input_tokens ?? 0,
      };
    } else if (info.last_token_usage) {
      usage = tokenUsageValues(info.last_token_usage);
    }

    if (currentDate && usage) addSessionUsage(results, currentDate, model, usage);
  }

  return [...results.values()];
}

export async function readCodexData(): Promise<DayMap> {
  const roots = getCodexPaths();
  const seenPaths = new Set<string>();
  const allDays: DayMap = new Map();

  for (const root of roots) {
    const files = await listJsonlFiles(root);
    for (const file of files) {
      if (seenPaths.has(file)) continue;
      seenPaths.add(file);

      const results = await parseSessionFile(file);
      for (const { dateStr, model, inputTokens, outputTokens, cachedInputTokens } of results) {
        const day = getOrCreateDay(allDays, dateStr);
        const modelTotals = (day.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
        modelTotals.inputTokens += inputTokens;
        modelTotals.outputTokens += outputTokens;
        modelTotals.cachedInputTokens = (modelTotals.cachedInputTokens ?? 0) + cachedInputTokens;
        day.inputTokens += inputTokens;
        day.outputTokens += outputTokens;
        day.cachedInputTokens = (day.cachedInputTokens ?? 0) + cachedInputTokens;

        const cost = estimateCodexCostUSD(
          model,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          dateStr,
        );
        if (cost !== undefined) {
          modelTotals.costUSD = (modelTotals.costUSD ?? 0) + cost;
          day.costUSD = (day.costUSD ?? 0) + cost;
        }
      }
    }
  }

  return allDays;
}
