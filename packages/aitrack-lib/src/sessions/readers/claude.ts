import { basename } from 'node:path';

import { addModelUsage, getOrCreateDay, tryLocalDateString } from '../../data/dayMap.js';
import { isRecord } from '../../data/guards.js';
import { stripModelAliasSuffix } from '../../data/modelId.js';
import type { DayMap } from '../../data/types.js';
import { claudeCacheWriteTokens, estimateClaudeCostUSD } from '../../pricing/claude.js';
import type { ClaudeMessageUsage } from '../../pricing/claude.js';
import { streamJsonlObjects } from '../../readers/jsonl.js';
import { deriveSession, sessionId } from '../finalize.js';
import {
  clipExcerpt,
  countToolUses,
  parseTimestamp,
  textOfContent,
  touchesFromToolContent,
} from '../text.js';
import type { FileTouch, ReadSessionResult, SessionTurn } from '../types.js';

interface CountedUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  rawInputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens: number;
  costUSD: number | null;
}

interface AssistantDraft {
  at: string | null;
  day: string | null;
  sidechain: boolean;
  usage: CountedUsage | null;
  toolCalls: number;
  touches: ReturnType<typeof touchesFromToolContent>;
  text: string;
}

/**
 * Read one Claude Code transcript as a session.
 *
 * Token totals follow `parseJsonlFile`: assistant usage only, the fullest
 * record per message id, cache writes included in input. User text is clipped
 * into `signals` and is not part of `session`.
 */
export async function readClaudeSessionFile(filePath: string): Promise<ReadSessionResult> {
  let externalId = basename(filePath).replace(/\.jsonl$/u, '');
  let cwd: string | null = null;
  const branches: string[] = [];
  let partial = false;
  const turns: SessionTurn[] = [];
  const userBits: string[] = [];
  const assistantBits: string[] = [];
  const dedupeKeys: string[] = [];
  const chosen = new Map<string, AssistantDraft>();
  const unkeyed: AssistantDraft[] = [];
  const ordered: Array<
    | { kind: 'user'; at: string | null; sidechain: boolean; text: string }
    | { kind: 'assistant'; key: string | null }
  > = [];

  for await (const entry of streamJsonlObjects(filePath)) {
    const sessionField = entry.sessionId;
    if (typeof sessionField === 'string' && sessionField !== '') {
      if (externalId !== sessionField && !externalId.endsWith(sessionField) && ordered.length > 0) {
        partial = true;
      }
      externalId = sessionField;
    }
    if (typeof entry.cwd === 'string' && entry.cwd !== '' && cwd === null) cwd = entry.cwd;
    if (typeof entry.gitBranch === 'string' && entry.gitBranch !== '')
      branches.push(entry.gitBranch);

    if (entry.type === 'user') {
      const text = textOfContent(messageContent(entry));
      ordered.push({
        kind: 'user',
        at: parseTimestamp(entry.timestamp),
        sidechain: entry.isSidechain === true,
        text,
      });
      continue;
    }

    if (entry.type !== 'assistant') continue;
    const draft = assistantDraft(entry);
    const key = messageKey(entry);
    if (key === null) {
      unkeyed.push(draft);
      ordered.push({ kind: 'assistant', key: null });
      continue;
    }
    const existing = chosen.get(key);
    if (existing === undefined) {
      chosen.set(key, draft);
      ordered.push({ kind: 'assistant', key });
      continue;
    }
    if (isRicher(draft, existing)) chosen.set(key, draft);
  }

  const seenAssistant = new Set<string>();
  let index = 0;
  const touches: FileTouch[] = [];
  for (const item of ordered) {
    if (item.kind === 'user') {
      turns.push(emptyTurn(index, 'user', item.at, item.sidechain));
      if (item.text !== '') userBits.push(item.text);
      index += 1;
      continue;
    }
    if (item.key !== null) {
      if (seenAssistant.has(item.key)) continue;
      seenAssistant.add(item.key);
      const draft = chosen.get(item.key);
      if (draft === undefined) continue;
      dedupeKeys.push(item.key);
      pushAssistant(turns, touches, index, draft);
      if (draft.text !== '') assistantBits.push(draft.text);
      index += 1;
      continue;
    }
    const draft = unkeyed.shift();
    if (draft === undefined) continue;
    pushAssistant(turns, touches, index, draft);
    if (draft.text !== '') assistantBits.push(draft.text);
    index += 1;
  }

  const derived = deriveSession(turns, touches, branches);
  return {
    session: {
      id: sessionId('claude', externalId),
      provider: 'claude',
      externalId,
      sourcePath: filePath,
      cwd,
      cwdUncertain: cwd === null,
      partial,
      tokensKnown: true,
      fileTouches: touches,
      ...derived,
    },
    signals: {
      userExcerpt: clipExcerpt(userBits.join('\n')),
      assistantExcerpt: clipExcerpt(assistantBits.at(-1) ?? ''),
    },
    dedupeKeys,
    usage: usageSnapshot(chosen, unkeyed),
  };
}

function pushAssistant(
  turns: SessionTurn[],
  touches: ReadSessionResult['session']['fileTouches'],
  index: number,
  draft: AssistantDraft,
): void {
  const usage = draft.usage;
  turns.push({
    index,
    startedAt: draft.at,
    endedAt: null,
    role: 'assistant',
    model: usage?.model ?? null,
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    rawInputTokens: usage?.rawInputTokens ?? 0,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
    cacheCreation1hInputTokens: usage?.cacheCreation1hInputTokens ?? 0,
    costUSD: usage?.costUSD ?? null,
    toolCalls: draft.toolCalls,
    sidechain: draft.sidechain,
  });
  for (const touch of draft.touches) touches.push({ ...touch, turnIndex: index });
}

function emptyTurn(
  index: number,
  role: 'user' | 'assistant',
  at: string | null,
  sidechain: boolean,
): SessionTurn {
  return {
    index,
    startedAt: at,
    endedAt: null,
    role,
    model: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rawInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    costUSD: null,
    toolCalls: 0,
    sidechain,
  };
}

function messageContent(entry: Record<string, unknown>): unknown {
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  return message.content;
}

function messageKey(entry: Record<string, unknown>): string | null {
  const message = isRecord(entry.message) ? entry.message : {};
  const id = typeof message.id === 'string' ? message.id : '';
  const requestId = typeof entry.requestId === 'string' ? entry.requestId : '';
  if (id === '' && requestId === '') return null;
  return `${id}:${requestId}`;
}

function assistantDraft(entry: Record<string, unknown>): AssistantDraft {
  const at = parseTimestamp(entry.timestamp);
  const raw = entry.timestamp;
  const day = typeof raw === 'string' ? tryLocalDateString(raw) : null;
  const content = messageContent(entry);
  return {
    at,
    day,
    sidechain: entry.isSidechain === true,
    usage: usageOf(entry, day),
    toolCalls: countToolUses(content),
    touches: touchesFromToolContent(content, at, 0),
    text: textOfContent(content),
  };
}

function usageSnapshot(
  chosen: Map<string, AssistantDraft>,
  unkeyed: AssistantDraft[],
): { days: DayMap; keys: string[] } {
  const days: DayMap = new Map();
  const keys: string[] = [];
  for (const [key, draft] of chosen) {
    if (addDraftUsage(days, draft)) keys.push(key);
  }
  for (const draft of unkeyed) addDraftUsage(days, draft);
  return { days, keys };
}

function addDraftUsage(days: DayMap, draft: AssistantDraft): boolean {
  const usage = draft.usage;
  if (usage === null || draft.day === null) return false;
  const day = getOrCreateDay(days, draft.day);
  addModelUsage(day, usage.model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    rawInputTokens: usage.rawInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    ...(usage.cacheCreation1hInputTokens > 0 && {
      cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens,
    }),
    ...(usage.costUSD !== null && { costUSD: usage.costUSD }),
  });
  return true;
}

function usageOf(entry: Record<string, unknown>, day: string | null): CountedUsage | null {
  const message = isRecord(entry.message) ? entry.message : {};
  const usage = isRecord(message.usage) ? (message.usage as ClaudeMessageUsage) : null;
  if (usage === null) return null;
  const writes = claudeCacheWriteTokens(usage);
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    writes.fiveMinute +
    writes.oneHour;
  const outputTokens = usage.output_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  const model = stripModelAliasSuffix(
    typeof message.model === 'string' ? message.model : 'unknown',
  );
  const costUSD = estimateClaudeCostUSD(model, usage, day ?? undefined);
  return {
    model,
    inputTokens,
    outputTokens,
    rawInputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: writes.fiveMinute,
    cacheCreation1hInputTokens: writes.oneHour,
    costUSD: costUSD ?? null,
  };
}

/** Same fullness rule as the day-map reader: more output, then more input, else the later row. */
function isRicher(next: AssistantDraft, current: AssistantDraft): boolean {
  const nextOutput = next.usage?.outputTokens ?? 0;
  const currentOutput = current.usage?.outputTokens ?? 0;
  if (nextOutput !== currentOutput) return nextOutput > currentOutput;
  const nextInput = next.usage?.inputTokens ?? 0;
  const currentInput = current.usage?.inputTokens ?? 0;
  if (nextInput !== currentInput) return nextInput > currentInput;
  return true;
}
