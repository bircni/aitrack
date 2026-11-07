import { isRecord } from '../data/guards.js';
import { type JsonlFilter, streamJsonlObjects } from './jsonl.js';
import { isOptionalTokenCount, logCwd, logDay, logModel } from './logValues.js';

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

/** Cast from the log: a field is checked before it is trusted. */
interface CodexEntry {
  type: string;
  timestamp?: unknown;
  payload?: {
    type?: string;
    model?: unknown;
    cwd?: unknown;
    git?: { repository_url?: unknown };
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

interface ReportedUsage {
  inputTokens: number;
  outputTokens: number;
  /** Left unset rather than zero: "not reported" must not look like a reset. */
  cachedInputTokens?: number;
}

/** Null when any count is malformed: part of a broken record is not worth counting. */
function reportedUsage(usage: unknown): ReportedUsage | null {
  if (!isRecord(usage)) return null;
  const { input_tokens, output_tokens, cached_input_tokens } = usage as TokenUsage;
  if (
    ![input_tokens, output_tokens, cached_input_tokens].every((tokens) =>
      isOptionalTokenCount(tokens),
    )
  ) {
    return null;
  }
  return {
    inputTokens: input_tokens ?? 0,
    outputTokens: output_tokens ?? 0,
    ...(typeof cached_input_tokens === 'number' && { cachedInputTokens: cached_input_tokens }),
  };
}

function asSessionUsage({ inputTokens, outputTokens, cachedInputTokens }: ReportedUsage) {
  return { inputTokens, outputTokens, cachedInputTokens: cachedInputTokens ?? 0 };
}

const NO_USAGE: SessionUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

/** What one `token_count` adds, and the running total after it; null when it holds nothing usable. */
function usageSince(
  info: NonNullable<NonNullable<CodexEntry['payload']>['info']>,
  previous: SessionUsage,
): { usage: SessionUsage; total: SessionUsage } | null {
  if (!info.total_token_usage) {
    const last = reportedUsage(info.last_token_usage);
    return last && { usage: asSessionUsage(last), total: previous };
  }
  const current = reportedUsage(info.total_token_usage);
  if (!current) return null; // The next good total still includes this turn.
  const total = {
    inputTokens: current.inputTokens,
    outputTokens: current.outputTokens,
    cachedInputTokens: current.cachedInputTokens ?? previous.cachedInputTokens,
  };
  // Only an input or output drop means the cumulative counter compacted.
  if (current.inputTokens < previous.inputTokens || current.outputTokens < previous.outputTokens) {
    return { usage: asSessionUsage(reportedUsage(info.last_token_usage) ?? current), total };
  }
  return {
    usage: {
      inputTokens: total.inputTokens - previous.inputTokens,
      outputTokens: total.outputTokens - previous.outputTokens,
      cachedInputTokens: Math.max(0, total.cachedInputTokens - previous.cachedInputTokens),
    },
    total,
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
    holds: (entry) => logDay(entry.timestamp) !== null,
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
  let previousTotal = NO_USAGE;
  const results = new Map<string, SessionTotals>();
  let repositoryUrl: string | undefined;
  let cwd: string | undefined;

  for await (const parsed of streamJsonlObjects(filePath, CODEX_LINES)) {
    const entry = parsed as unknown as CodexEntry;

    if (entry.type === 'session_meta' || (entry.type === 'turn_context' && cwd === undefined)) {
      const url = entry.payload?.git?.repository_url;
      if (typeof url === 'string') repositoryUrl ??= url;
      cwd ??= logCwd(entry.payload?.cwd);
    }

    currentDate = logDay(entry.timestamp) ?? currentDate;

    if (entry.type === 'turn_context') model = logModel(entry.payload?.model) ?? model;

    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;

    const info = entry.payload.info;
    const step = info ? usageSince(info, previousTotal) : null;
    if (!step) continue;
    previousTotal = step.total;
    if (currentDate) addSessionUsage(results, currentDate, model, step.usage);
  }

  return {
    sessions: [...results.values()],
    ...(repositoryUrl !== undefined && { repositoryUrl }),
    ...(cwd !== undefined && { cwd }),
  };
}
