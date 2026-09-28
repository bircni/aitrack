import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

import { isRecord } from '../../data/guards.js';
import { streamJsonlObjects } from '../../readers/jsonl.js';
import { deriveSession, sessionId } from '../finalize.js';
import { resolveEncodedPath } from '../slug.js';
import {
  clipExcerpt,
  countToolUses,
  parseTimestamp,
  textOfContent,
  touchesFromToolContent,
} from '../text.js';
import type { FileTouch, ReadSessionResult, Session, SessionTurn } from '../types.js';

const TIMESTAMP_TAG = /<timestamp>([^<]+)<\/timestamp>/u;
const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/u;
const CONTEXT_TAG =
  /<(?:manually_attached_skills|available_subagent_types|open_and_recently_viewed_files|agent_transcripts|system_reminder)>/u;

/** True for a nested agent transcript. Those belong to the parent chat, not their own session. */
export function isCursorSubagentTranscript(filePath: string): boolean {
  return filePath.split(sep).includes('subagents');
}

interface DraftTurn {
  role: 'user' | 'assistant';
  startedAt: string | null;
  toolCalls: number;
}

/**
 * Read one Cursor chat.
 *
 * A chat is the parent `agent-transcripts/<id>/<id>.jsonl`. Tool calls between
 * two user queries are one reply, and files under `subagents/` are part of
 * that same chat. Cursor has no per-session tokens (`tokensKnown` is false).
 */
export async function readCursorSessionFile(
  filePath: string,
  exists: (path: string) => boolean = existsSync,
): Promise<ReadSessionResult> {
  const externalId = basename(filePath).replace(/\.jsonl$/u, '');
  const slug = cursorProjectSlug(filePath);
  const resolved =
    slug === null
      ? null
      : resolveEncodedPath(slug, exists, process.platform === 'win32' ? 'win32' : 'posix');
  const drafts: DraftTurn[] = [];
  const touches: FileTouch[] = [];
  const seenTouches = new Map<string, { first: FileTouch; last: FileTouch | null }>();
  const userBits: string[] = [];
  let assistantText = '';
  let sawObject = false;
  let recognized = 0;

  const addTouch = (touch: FileTouch): void => {
    const key = `${touch.kind}\u0000${touch.path}`;
    const slot = seenTouches.get(key);
    if (slot === undefined) {
      seenTouches.set(key, { first: touch, last: null });
      return;
    }
    if (touch.at === null) return;
    const firstAt = slot.first.at;
    if (firstAt === null || touch.at < firstAt) {
      slot.last = slot.last ?? slot.first;
      slot.first = touch;
      return;
    }
    const lastAt = slot.last?.at ?? null;
    if (lastAt === null || touch.at > lastAt) slot.last = touch;
  };

  const absorb = (entry: Record<string, unknown>, prompts: boolean): void => {
    const role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : null;
    if (role === null) return;
    recognized += 1;
    const content = isRecord(entry.message) ? entry.message.content : undefined;
    const text = textOfContent(content);
    const at = timestampFrom(entry, text);
    if (role === 'user') {
      if (!prompts) return;
      const prompt = promptOf(text);
      if (prompt === null) return;
      drafts.push({ role: 'user', startedAt: at, toolCalls: 0 });
      userBits.push(prompt);
      return;
    }
    const last = drafts.at(-1);
    if (last?.role !== 'assistant') {
      drafts.push({ role: 'assistant', startedAt: at, toolCalls: 0 });
    }
    const current = drafts.at(-1);
    if (current === undefined) return;
    current.startedAt ??= at;
    current.toolCalls += countToolUses(content);
    if (prompts && text !== '') assistantText = text;
    const index = drafts.length - 1;
    for (const touch of touchesFromToolContent(content, at, index)) addTouch(touch);
  };

  for await (const entry of streamJsonlObjects(filePath)) {
    sawObject = true;
    absorb(entry, true);
  }
  if (!isCursorSubagentTranscript(filePath)) {
    await foldSubagents(filePath, (entry) => {
      absorb(entry, false);
    });
  }
  for (const slot of seenTouches.values()) {
    touches.push(slot.first);
    if (slot.last !== null && slot.last.at !== slot.first.at) touches.push(slot.last);
  }

  const turns: SessionTurn[] = drafts.map((draft, index) => ({
    index,
    startedAt: draft.startedAt,
    endedAt: null,
    role: draft.role,
    model: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rawInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    costUSD: null,
    toolCalls: draft.toolCalls,
    sidechain: false,
  }));
  const derived = deriveSession(turns, touches, []);
  const title = userBits[0] === undefined ? derived.title : titleFromPrompt(userBits[0]);
  return {
    session: {
      id: sessionId('cursor', externalId),
      provider: 'cursor',
      externalId,
      sourcePath: filePath,
      cwd: resolved?.path ?? null,
      cwdUncertain: resolved === null || resolved.uncertain || resolved.path === null,
      partial: sawObject && recognized === 0,
      tokensKnown: false,
      fileTouches: touches,
      ...derived,
      title,
    },
    signals: {
      userExcerpt: clipExcerpt(userBits.join('\n')),
      assistantExcerpt: clipExcerpt(stripTags(assistantText)),
    },
    dedupeKeys: [],
    usage: null,
  };
}

async function foldSubagents(
  parentFile: string,
  absorb: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const dir = join(dirname(parentFile), 'subagents');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    for await (const entry of streamJsonlObjects(join(dir, name))) absorb(entry);
  }
}

function promptOf(text: string): string | null {
  const tagged = USER_QUERY.exec(text);
  const inner = tagged?.[1];
  if (inner !== undefined && inner.trim() !== '') return inner.trim();
  if (CONTEXT_TAG.test(text)) return null;
  const stripped = stripTags(text).trim();
  return stripped === '' ? null : stripped;
}

function titleFromPrompt(prompt: string): string {
  const flat = prompt.replaceAll(/\s+/gu, ' ').trim();
  if (flat.length <= 90) return flat;
  return `${flat.slice(0, 89)}…`;
}

/** Fill timestamps from `composerData` when the transcript itself has none. */
export function applyComposerBounds(
  session: Session,
  startedAt: string | null,
  endedAt: string | null,
): Session {
  const started = session.startedAt ?? startedAt;
  const ended = session.endedAt ?? endedAt ?? started;
  return { ...session, startedAt: started, endedAt: ended };
}

export function cursorProjectSlug(filePath: string): string | null {
  const parts = filePath.split(sep);
  const marker = parts.lastIndexOf('agent-transcripts');
  if (marker <= 0) return null;
  return parts[marker - 1] ?? null;
}

function timestampFrom(entry: Record<string, unknown>, text: string): string | null {
  const direct = parseTimestamp(entry.timestamp) ?? parseTimestamp(entry.createdAt);
  if (direct !== null) return direct;
  const tagged = TIMESTAMP_TAG.exec(text)?.[1];
  if (tagged === undefined) return null;
  return parseTimestamp(tagged) ?? parseTimestamp(tagged.replaceAll(/\([^)]*\)/gu, '').trim());
}

function stripTags(text: string): string {
  return text.replaceAll(/<timestamp>[^<]*<\/timestamp>/gu, ' ');
}
