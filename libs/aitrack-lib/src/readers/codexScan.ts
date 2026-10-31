import { tryLocalDateString } from '../data/dayMap.js';
import { type JsonlFilter, streamJsonlObjects } from './jsonl.js';

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

export interface SessionTotals extends SessionUsage {
  dateStr: string;
  model: string;
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

/** Every line moves the current day; only these types are read for more. */
const CODEX_LINES: JsonlFilter = {
  needles: ['"session_meta"', '"turn_context"', '"token_count"'],
  carry: {
    needle: '"timestamp"',
    holds: (entry) =>
      typeof entry.timestamp === 'string' && tryLocalDateString(entry.timestamp) !== null,
  },
};

/** A session's totals and where it ran. Self-contained so a worker can run it. */
export interface CodexScan {
  sessions: SessionTotals[];
  repositoryUrl?: string;
  cwd?: string;
}

export async function scanCodexFile(filePath: string): Promise<CodexScan> {
  let currentDate: string | null = null;
  let model = 'unknown';
  let previousTotal = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  const results = new Map<string, SessionTotals>();
  let repositoryUrl: string | undefined;
  let cwd: string | undefined;

  for await (const parsed of streamJsonlObjects(filePath, CODEX_LINES)) {
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

  return {
    sessions: [...results.values()],
    ...(repositoryUrl !== undefined && { repositoryUrl }),
    ...(cwd !== undefined && { cwd }),
  };
}
