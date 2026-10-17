import { join } from 'node:path';

import { tryLoadConfig } from '../config.js';
import {
  addModelUsage,
  type Attribution,
  getOrCreateDay,
  mergeDayMaps,
  tryLocalDateString,
} from '../data/dayMap.js';
import { normalizeRemoteUrl } from '../data/project.js';
import type { DayMap } from '../data/types.js';
import { environmentValue } from '../env.js';
import { estimateCodexCostUSD } from '../pricing/codex.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import type { CachedParse } from './cache.js';
import { streamJsonlObjects } from './jsonl.js';
import { codexHomeDirs, resolveSourceRoots } from './paths.js';
import { parseProviderSources } from './pipeline.js';
import { attributeCwd, createProjectResolver, type ProjectResolver } from './projectResolver.js';

export function getCodexPaths(): string[] {
  return resolveSourceRoots({
    envValue: environmentValue('AITRACK_CODEX_SESSION_DIRS'),
    configValue: tryLoadConfig()?.codexSessionsDir,
    defaults: codexHomeDirs().map((dir) => join(dir, 'sessions')),
  });
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  /**
   * Subset of `output_tokens`, not an extra bucket. Adding it on top would
   * bill reasoning twice.
   */
  reasoning_output_tokens?: number;
}

interface CodexEntry {
  type: string;
  timestamp?: string;
  payload?: {
    type?: string;
    model?: string;
    cwd?: string;
    git?: { repository_url?: string };
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
    };
  };
}

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

interface SessionTotals extends SessionUsage {
  dateStr: string;
  model: string;
}

interface SessionResult extends SessionTotals {
  /** One per session file, so every result of a file shares it. */
  attribution: Attribution;
}

function tokenUsageValues(usage: TokenUsage): SessionUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
  };
}

function addSessionUsage(
  results: Map<string, SessionTotals>,
  dateStr: string,
  model: string,
  usage: SessionUsage,
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

export async function parseSessionFile(
  filePath: string,
  resolveProject: ProjectResolver = createProjectResolver(),
): Promise<SessionResult[]> {
  let currentDate: string | null = null;
  let model = 'unknown';
  let previousTotal = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  const results = new Map<string, SessionTotals>();
  let repositoryUrl: string | undefined;
  let cwd: string | undefined;

  for await (const parsed of streamJsonlObjects(filePath)) {
    const entry = parsed as unknown as CodexEntry;

    if (entry.type === 'session_meta' || (entry.type === 'turn_context' && cwd === undefined)) {
      repositoryUrl ??= entry.payload?.git?.repository_url;
      cwd ??= entry.payload?.cwd;
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

    let usage: SessionUsage | null = null;
    if (info.total_token_usage) {
      const current = info.total_token_usage;
      const currentInput = current.input_tokens ?? 0;
      const currentOutput = current.output_tokens ?? 0;
      // A missing cached count is "not reported", not a reset to zero. Only an
      // input or output drop means the cumulative counter compacted.
      const isRolledBack =
        currentInput < previousTotal.input_tokens || currentOutput < previousTotal.output_tokens;

      if (isRolledBack) {
        usage = tokenUsageValues(info.last_token_usage ?? current);
      } else {
        const cachedNow = current.cached_input_tokens ?? previousTotal.cached_input_tokens;
        usage = {
          inputTokens: Math.max(0, currentInput - previousTotal.input_tokens),
          outputTokens: Math.max(0, currentOutput - previousTotal.output_tokens),
          cachedInputTokens: Math.max(0, cachedNow - previousTotal.cached_input_tokens),
        };
      }
      previousTotal = {
        input_tokens: currentInput,
        output_tokens: currentOutput,
        cached_input_tokens: current.cached_input_tokens ?? previousTotal.cached_input_tokens,
      };
    } else if (info.last_token_usage) {
      usage = tokenUsageValues(info.last_token_usage);
    }

    if (currentDate && usage) addSessionUsage(results, currentDate, model, usage);
  }

  const remote = repositoryUrl === undefined ? null : normalizeRemoteUrl(repositoryUrl);
  const attribution: Attribution =
    remote === null ? await attributeCwd(resolveProject, cwd) : { project: remote };
  return [...results.values()].map((result) => ({ ...result, attribution }));
}

function addSessionResult(
  allDays: DayMap,
  result: SessionResult,
  fallbacks?: FallbackCollector,
): void {
  const { dateStr, model, inputTokens, outputTokens, cachedInputTokens } = result;
  const day = getOrCreateDay(allDays, dateStr);
  const cost = estimateCodexCostUSD(
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    dateStr,
    fallbacks,
  );
  addModelUsage(
    day,
    model,
    {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      ...(cost !== undefined && { costUSD: cost }),
    },
    result.attribution,
  );
}

/**
 * One session file's contribution, computed from its own bytes alone so it can
 * be cached. Codex has no cross-file de-duplication, so there are no keys.
 */
async function parseCodexFile(
  filePath: string,
  fallbacks: FallbackCollector | undefined,
  resolveProject: ProjectResolver,
): Promise<CachedParse> {
  const days: DayMap = new Map();
  for (const result of await parseSessionFile(filePath, resolveProject)) {
    addSessionResult(days, result, fallbacks);
  }
  return { days, keys: [] };
}

export async function readCodexData(fallbacks?: FallbackCollector): Promise<DayMap> {
  const resolveProject = createProjectResolver();
  const parsed = await parseProviderSources({
    cacheName: 'codex',
    roots: getCodexPaths(),
    parseFile: (filePath, collector) => parseCodexFile(filePath, collector, resolveProject),
    fallbacks,
  });

  const allDays: DayMap = new Map();
  for (const entry of parsed) mergeDayMaps(allDays, entry.days);
  return allDays;
}
