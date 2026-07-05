import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { tryLoadConfig } from '../config.js';
import { getOrCreateDay, toLocalDateString } from '../data/dayMap.js';
import type { DayMap } from '../data/types.js';
import { estimateCodexCostUSD } from '../pricing/codex.js';
import { splitConfiguredPaths } from './paths.js';

export function getCodexPaths(): string[] {
  const paths = new Set<string>(splitConfiguredPaths(process.env.AITRACK_CODEX_SESSION_DIRS));
  const configuredPaths = splitConfiguredPaths(tryLoadConfig()?.codexSessionsDir);
  for (const path of configuredPaths) {
    paths.add(path);
  }
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) paths.add(join(codexHome, 'sessions'));
  paths.add(join(homedir(), '.codex', 'sessions'));
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

export async function parseSessionFile(filePath: string): Promise<SessionResult | null> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let sessionDate: string | null = null;
  let model = 'unknown';
  let previousTotal = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  const accumulated = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line) as CodexEntry;
    } catch {
      continue;
    }

    if (sessionDate === null && entry.timestamp) {
      sessionDate = toLocalDateString(entry.timestamp);
    }

    if (entry.type === 'turn_context' && entry.payload?.model) {
      model = entry.payload.model;
    }

    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;

    const info = entry.payload.info;
    if (!info) continue;

    if (info.total_token_usage) {
      const current = info.total_token_usage;
      const isRolledBack =
        (current.input_tokens ?? 0) < previousTotal.input_tokens ||
        (current.output_tokens ?? 0) < previousTotal.output_tokens;

      if (isRolledBack && info.last_token_usage) {
        const last = info.last_token_usage;
        accumulated.inputTokens += last.input_tokens ?? 0;
        accumulated.outputTokens += last.output_tokens ?? 0;
        accumulated.cachedInputTokens += last.cached_input_tokens ?? 0;
      } else {
        accumulated.inputTokens += Math.max(
          0,
          (current.input_tokens ?? 0) - previousTotal.input_tokens,
        );
        accumulated.outputTokens += Math.max(
          0,
          (current.output_tokens ?? 0) - previousTotal.output_tokens,
        );
        accumulated.cachedInputTokens += Math.max(
          0,
          (current.cached_input_tokens ?? 0) - previousTotal.cached_input_tokens,
        );
      }
      previousTotal = {
        input_tokens: current.input_tokens ?? 0,
        output_tokens: current.output_tokens ?? 0,
        cached_input_tokens: current.cached_input_tokens ?? 0,
      };
    } else if (info.last_token_usage) {
      const last = info.last_token_usage;
      accumulated.inputTokens += last.input_tokens ?? 0;
      accumulated.outputTokens += last.output_tokens ?? 0;
      accumulated.cachedInputTokens += last.cached_input_tokens ?? 0;
    }
  }

  if (!sessionDate || (accumulated.inputTokens === 0 && accumulated.outputTokens === 0))
    return null;
  return { dateStr: sessionDate, model, ...accumulated };
}

export async function readCodexData(): Promise<DayMap> {
  const roots = getCodexPaths();
  const seenPaths = new Set<string>();
  const allDays: DayMap = new Map();

  for (const root of roots) {
    const files = await findJsonlFiles(root);
    for (const file of files) {
      const resolved = resolve(file);
      if (seenPaths.has(resolved)) continue;
      seenPaths.add(resolved);

      const result = await parseSessionFile(resolved);
      if (!result) continue;

      const { dateStr, model, inputTokens, outputTokens, cachedInputTokens } = result;
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

  return allDays;
}
