import { basename } from 'node:path';

import { addModelUsage, getOrCreateDay, tryLocalDateString } from '../../data/dayMap.js';
import { isRecord } from '../../data/guards.js';
import type { DayMap } from '../../data/types.js';
import { estimateCodexCostUSD } from '../../pricing/codex.js';
import { streamJsonlObjects } from '../../readers/jsonl.js';
import { deriveSession, sessionId } from '../finalize.js';
import { clipExcerpt, parseTimestamp, pathsInCommand, textOfContent } from '../text.js';
import type { FileTouch, ReadSessionResult, SessionTurn } from '../types.js';

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface OpenTurn {
  at: string | null;
  endedAt: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUSD: number | null;
  toolCalls: number;
}

/**
 * Read one Codex rollout.
 *
 * Token deltas follow `parseSessionFile` (cumulative totals, reset when input
 * or output drops). Tasks become turns. Shell and patch commands contribute
 * file touches; their text is not stored.
 */
export async function readCodexSessionFile(filePath: string): Promise<ReadSessionResult> {
  let externalId = basename(filePath).replace(/\.jsonl$/u, '');
  let cwd: string | null = null;
  let model = 'unknown';
  let previousTotal = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  let currentDate: string | null = null;
  let usageDate: string | null = null;
  const buckets = new Map<string, TokenBucket>();
  const openTurns: OpenTurn[] = [];
  let open: OpenTurn | null = null;
  const touches: FileTouch[] = [];
  const userBits: string[] = [];
  const assistantBits: string[] = [];
  let userMessages = 0;
  let assistantMessages = 0;
  const models = new Set<string>();

  for await (const entry of streamJsonlObjects(filePath)) {
    const payload = isRecord(entry.payload) ? entry.payload : {};
    const at = parseTimestamp(entry.timestamp);
    if (at !== null) currentDate = tryLocalDateString(at) ?? currentDate;
    if (typeof entry.timestamp === 'string' && entry.timestamp !== '') {
      usageDate = tryLocalDateString(entry.timestamp) ?? usageDate;
    }

    if (entry.type === 'session_meta') {
      const session = typeof payload.session_id === 'string' ? payload.session_id : '';
      if (session !== '') externalId = session;
      cwd = firstCwd(payload) ?? cwd;
      continue;
    }

    if (
      entry.type === 'turn_context' &&
      typeof payload.model === 'string' &&
      payload.model !== ''
    ) {
      model = payload.model;
      models.add(model);
    }

    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      open = {
        at,
        endedAt: null,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUSD: null,
        toolCalls: 0,
      };
      openTurns.push(open);
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'task_complete' && open !== null) {
      open.endedAt = at;
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'token_count') {
      const delta = tokenDelta(payload, previousTotal);
      previousTotal = delta.previous;
      if (delta.usage !== null && usageDate !== null) {
        addBucket(buckets, usageDate, model, delta.usage);
      }
      if (delta.usage === null || currentDate === null) continue;
      const target = open ?? spillTurn(openTurns, at, model);
      target.inputTokens += delta.usage.inputTokens;
      target.outputTokens += delta.usage.outputTokens;
      target.cachedInputTokens += delta.usage.cachedInputTokens;
      const priced = estimateCodexCostUSD(
        model,
        delta.usage.inputTokens,
        delta.usage.outputTokens,
        delta.usage.cachedInputTokens,
        currentDate,
      );
      if (priced !== undefined) target.costUSD = (target.costUSD ?? 0) + priced;
      target.model = model;
      models.add(model);
      continue;
    }

    if (entry.type !== 'response_item') continue;
    const role = roleOf(payload);
    if (role === 'user') {
      userMessages += 1;
      const text = textOfContent(payload.content ?? messageContent(payload));
      if (text !== '') userBits.push(text);
    } else if (role === 'assistant') {
      assistantMessages += 1;
      const text = textOfContent(payload.content ?? messageContent(payload));
      if (text !== '') assistantBits.push(text);
    }

    if (payload.type !== 'custom_tool_call' && payload.type !== 'function_call') continue;
    const command = commandText(payload);
    const found = pathsInCommand(command);
    const turnIndex = Math.max(0, openTurns.length - 1);
    if (open !== null) open.toolCalls += 1;
    for (const path of found) {
      touches.push({ path: path.path, kind: path.kind, at, turnIndex });
    }
  }

  const turns: SessionTurn[] = openTurns.map((turn, index) => {
    return {
      index,
      startedAt: turn.at,
      endedAt: turn.endedAt,
      role: 'assistant',
      model: turn.model,
      inputTokens: turn.inputTokens,
      cachedInputTokens: turn.cachedInputTokens,
      outputTokens: turn.outputTokens,
      rawInputTokens: Math.max(0, turn.inputTokens - turn.cachedInputTokens),
      cacheCreationInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      costUSD: turn.costUSD,
      toolCalls: turn.toolCalls,
      sidechain: false,
    };
  });

  const derived = deriveSession(turns, touches, []);
  if (userMessages + assistantMessages > 0) {
    derived.userMessages = userMessages;
    derived.assistantMessages = assistantMessages;
  }
  if (models.size > 0) derived.models = [...models];

  return {
    session: {
      id: sessionId('codex', externalId),
      provider: 'codex',
      externalId,
      sourcePath: filePath,
      cwd,
      cwdUncertain: cwd === null,
      partial: false,
      tokensKnown: true,
      fileTouches: touches,
      ...derived,
    },
    signals: {
      userExcerpt: clipExcerpt(userBits.join('\n')),
      assistantExcerpt: clipExcerpt(assistantBits.at(-1) ?? ''),
    },
    dedupeKeys: [],
    usage: codexUsage(buckets),
  };
}

interface TokenBucket {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

function addBucket(
  buckets: Map<string, TokenBucket>,
  dateStr: string,
  modelName: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): void {
  const key = `${dateStr}\u0000${modelName}`;
  const bucket = buckets.get(key) ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  bucket.inputTokens += usage.inputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.cachedInputTokens += usage.cachedInputTokens;
  buckets.set(key, bucket);
}

function codexUsage(buckets: Map<string, TokenBucket>): { days: DayMap; keys: string[] } {
  const days: DayMap = new Map();
  for (const [key, bucket] of buckets) {
    const split = key.indexOf('\u0000');
    const dateStr = key.slice(0, split);
    const modelName = key.slice(split + 1);
    const day = getOrCreateDay(days, dateStr);
    const cost = estimateCodexCostUSD(
      modelName,
      bucket.inputTokens,
      bucket.outputTokens,
      bucket.cachedInputTokens,
      dateStr,
    );
    addModelUsage(day, modelName, {
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cachedInputTokens: bucket.cachedInputTokens,
      ...(cost !== undefined && { costUSD: cost }),
    });
  }
  return { days, keys: [] };
}

function spillTurn(turns: OpenTurn[], at: string | null, model: string): OpenTurn {
  const last = turns.at(-1);
  if (last !== undefined) return last;
  const created: OpenTurn = {
    at,
    endedAt: null,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUSD: null,
    toolCalls: 0,
  };
  turns.push(created);
  return created;
}

function firstCwd(payload: Record<string, unknown>): string | null {
  if (typeof payload.cwd === 'string' && payload.cwd !== '') return payload.cwd;
  return firstString(payload.runtime_workspace_roots);
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === 'string' && item !== '') return item;
  }
  return null;
}

function roleOf(payload: Record<string, unknown>): 'user' | 'assistant' | null {
  if (payload.role === 'user' || payload.role === 'assistant') return payload.role;
  const message = payload.message;
  if (!isRecord(message)) return null;
  if (message.role === 'user' || message.role === 'assistant') return message.role;
  return null;
}

function messageContent(payload: Record<string, unknown>): unknown {
  const message = payload.message;
  if (!isRecord(message)) return undefined;
  return message.content;
}

function commandText(payload: Record<string, unknown>): string {
  if (typeof payload.input === 'string') return payload.input;
  if (typeof payload.arguments === 'string') return payload.arguments;
  return '';
}

function tokenDelta(
  payload: Record<string, unknown>,
  previousTotal: { input_tokens: number; output_tokens: number; cached_input_tokens: number },
): {
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
  previous: { input_tokens: number; output_tokens: number; cached_input_tokens: number };
} {
  const info = isRecord(payload.info) ? payload.info : null;
  if (info === null) return { usage: null, previous: previousTotal };
  const total = isRecord(info.total_token_usage) ? (info.total_token_usage as TokenUsage) : null;
  const last = isRecord(info.last_token_usage) ? (info.last_token_usage as TokenUsage) : null;
  if (total !== null) {
    const currentInput = total.input_tokens ?? 0;
    const currentOutput = total.output_tokens ?? 0;
    const rolledBack =
      currentInput < previousTotal.input_tokens || currentOutput < previousTotal.output_tokens;
    const usage = rolledBack
      ? values(last ?? total)
      : {
          inputTokens: Math.max(0, currentInput - previousTotal.input_tokens),
          outputTokens: Math.max(0, currentOutput - previousTotal.output_tokens),
          cachedInputTokens: Math.max(
            0,
            (total.cached_input_tokens ?? previousTotal.cached_input_tokens) -
              previousTotal.cached_input_tokens,
          ),
        };
    return {
      usage: usage.inputTokens === 0 && usage.outputTokens === 0 ? null : usage,
      previous: {
        input_tokens: currentInput,
        output_tokens: currentOutput,
        cached_input_tokens: total.cached_input_tokens ?? previousTotal.cached_input_tokens,
      },
    };
  }
  if (last === null) return { usage: null, previous: previousTotal };
  const usage = values(last);
  return {
    usage: usage.inputTokens === 0 && usage.outputTokens === 0 ? null : usage,
    previous: previousTotal,
  };
}

function values(usage: TokenUsage): {
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
