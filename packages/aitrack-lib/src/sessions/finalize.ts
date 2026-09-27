import { basename } from 'node:path';

import type { FileTouch, Session, SessionTurn } from './types.js';

export interface DerivedSession {
  branch: string | null;
  branches: string[];
  startedAt: string | null;
  endedAt: string | null;
  firstEditAt: string | null;
  lastEditAt: string | null;
  title: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUSD: number;
  models: string[];
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  turns: SessionTurn[];
}

const EDIT_KINDS = new Set<FileTouch['kind']>(['edit', 'create', 'delete']);

/** Fill the totals and timestamps that every reader would otherwise recompute. */
export function deriveSession(
  turns: SessionTurn[],
  touches: FileTouch[],
  branches: string[],
): DerivedSession {
  const distinctBranches = unique(branches);
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let costUSD = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const models: string[] = [];

  const stamped = turns.map((turn, index) => {
    const next = turns[index + 1];
    const ended = turn.endedAt ?? next?.startedAt ?? turn.startedAt;
    if (turn.startedAt !== null && (startedAt === null || turn.startedAt < startedAt)) {
      startedAt = turn.startedAt;
    }
    if (ended !== null && (endedAt === null || ended > endedAt)) endedAt = ended;
    inputTokens += turn.inputTokens;
    cachedInputTokens += turn.cachedInputTokens;
    outputTokens += turn.outputTokens;
    if (turn.costUSD !== null) costUSD += turn.costUSD;
    toolCalls += turn.toolCalls;
    if (turn.role === 'user') userMessages += 1;
    else assistantMessages += 1;
    if (turn.model !== null && !models.includes(turn.model)) models.push(turn.model);
    return { ...turn, index, endedAt: ended };
  });

  let firstEditAt: string | null = null;
  let lastEditAt: string | null = null;
  let title: string | null = null;
  for (const touch of touches) {
    if (!EDIT_KINDS.has(touch.kind)) continue;
    title ??= basename(touch.path);
    if (touch.at === null) continue;
    if (firstEditAt === null || touch.at < firstEditAt) firstEditAt = touch.at;
    if (lastEditAt === null || touch.at > lastEditAt) lastEditAt = touch.at;
  }

  return {
    branch: distinctBranches.at(-1) ?? null,
    branches: distinctBranches,
    startedAt,
    endedAt,
    firstEditAt,
    lastEditAt,
    title,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUSD,
    models,
    userMessages,
    assistantMessages,
    toolCalls,
    turns: stamped,
  };
}

export function emptySignals(): { userExcerpt: string; assistantExcerpt: string } {
  return { userExcerpt: '', assistantExcerpt: '' };
}

export function sessionId(provider: Session['provider'], externalId: string): string {
  return `${provider}:${externalId}`;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
