import type { TokenCounts } from '../data/types.js';
import {
  claudeBilledModel,
  type ClaudeMessageUsage,
  claudeUsageCounts,
} from '../pricing/claudeUsage.js';
import { type JsonlFilter, streamJsonlObjects } from './jsonl.js';
import { isOptionalTokenCount, logCwd, logDay, logModel } from './logValues.js';

/** Cast from the log: `logValues` checks a field before it is trusted. */
interface ClaudeEntry {
  type: string;
  timestamp?: unknown;
  cwd?: string;
  requestId?: string;
  message?: { id?: string; model?: unknown; usage?: ClaudeMessageUsage };
}

/** One counted message, before pricing and project attribution. */
export interface ScannedClaudeMessage {
  key?: string;
  date: string;
  model: string;
  counts: TokenCounts;
  cwd?: string;
}

function hasCwd(entry: { cwd?: unknown }): entry is { cwd: string } {
  return logCwd(entry.cwd) !== undefined;
}

function hasValidTokens(usage: ClaudeMessageUsage): boolean {
  const writes = usage.cache_creation;
  return [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
    writes?.ephemeral_5m_input_tokens,
    writes?.ephemeral_1h_input_tokens,
  ].every((tokens) => isOptionalTokenCount(tokens));
}

/** Only lines with usage are counted; any other line can still move the session's cwd. */
const CLAUDE_LINES: JsonlFilter = {
  needles: ['"usage"'],
  carry: { needle: '"cwd"', holds: hasCwd },
};

/** Prefer more output, then more input. A later record wins a tie. */
function isRicherUsage(next: TokenCounts, current: TokenCounts): boolean {
  if (next.outputTokens !== current.outputTokens) return next.outputTokens > current.outputTokens;
  if (next.inputTokens !== current.inputTokens) return next.inputTokens > current.inputTokens;
  return true;
}

/** Keyed messages first, in first-seen order, then unkeyed ones. Self-contained so a worker can run it. */
export async function scanClaudeFile(filePath: string): Promise<ScannedClaudeMessage[]> {
  const chosen = new Map<string, ScannedClaudeMessage>();
  const unkeyed: ScannedClaudeMessage[] = [];
  let cwd: string | undefined;

  for await (const parsed of streamJsonlObjects(filePath, CLAUDE_LINES)) {
    const entry = parsed as unknown as ClaudeEntry;

    if (hasCwd(entry)) cwd = entry.cwd;
    if (entry.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    if (!usage || !hasValidTokens(usage)) continue;

    const date = logDay(entry.timestamp);
    if (date === null) continue;

    const counts = claudeUsageCounts(usage);
    if (counts.inputTokens === 0 && counts.outputTokens === 0) continue;

    const model = claudeBilledModel(logModel(entry.message?.model) ?? 'unknown', usage, counts);
    const where = cwd === undefined ? {} : { cwd };

    // No id to dedupe on: count the row. A known id keeps the fullest record
    // in this file (a later correction replaces a partial stream entry).
    const key = `${entry.message?.id ?? ''}:${entry.requestId ?? ''}`;
    if (key === ':') {
      unkeyed.push({ date, model, counts, ...where });
      continue;
    }
    const existing = chosen.get(key);
    if (!existing || isRicherUsage(counts, existing.counts)) {
      chosen.set(key, { key, date, model, counts, ...where });
    }
  }
  return [...chosen.values(), ...unkeyed];
}
