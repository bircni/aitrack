import { createReadStream, existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createInterface } from 'readline';

import { getOrCreateDay, toLocalDateString } from '../dayMap.js';
import { estimateCodexCostUSD } from '../pricing/codex.js';
import type { DayMap } from '../types.js';

function getCodexPaths(): string[] {
  const paths = new Set<string>();
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
  let prevTotal = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
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
      const cur = info.total_token_usage;
      const rolledBack =
        (cur.input_tokens ?? 0) < prevTotal.input_tokens ||
        (cur.output_tokens ?? 0) < prevTotal.output_tokens;

      if (rolledBack && info.last_token_usage) {
        const last = info.last_token_usage;
        accumulated.inputTokens += last.input_tokens ?? 0;
        accumulated.outputTokens += last.output_tokens ?? 0;
        accumulated.cachedInputTokens += last.cached_input_tokens ?? 0;
        prevTotal = {
          input_tokens: cur.input_tokens ?? 0,
          output_tokens: cur.output_tokens ?? 0,
          cached_input_tokens: cur.cached_input_tokens ?? 0,
        };
      } else {
        accumulated.inputTokens += Math.max(0, (cur.input_tokens ?? 0) - prevTotal.input_tokens);
        accumulated.outputTokens += Math.max(0, (cur.output_tokens ?? 0) - prevTotal.output_tokens);
        accumulated.cachedInputTokens += Math.max(
          0,
          (cur.cached_input_tokens ?? 0) - prevTotal.cached_input_tokens,
        );
        prevTotal = {
          input_tokens: cur.input_tokens ?? 0,
          output_tokens: cur.output_tokens ?? 0,
          cached_input_tokens: cur.cached_input_tokens ?? 0,
        };
      }
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
