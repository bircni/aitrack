import { existsSync } from 'node:fs';
import { basename, sep } from 'node:path';

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
import type { ReadSessionResult, Session, SessionTurn } from '../types.js';

const TIMESTAMP_TAG = /<timestamp>([^<]+)<\/timestamp>/u;

/**
 * Read one Cursor agent transcript.
 *
 * Cursor's usage export is per day, so these sessions carry time, files and
 * conversation shape, not token totals (`tokensKnown` is false).
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
  const turns: SessionTurn[] = [];
  const touches: ReadSessionResult['session']['fileTouches'] = [];
  const userBits: string[] = [];
  const assistantBits: string[] = [];
  let sawObject = false;
  let recognized = 0;

  for await (const entry of streamJsonlObjects(filePath)) {
    sawObject = true;
    const role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : null;
    if (role === null) continue;
    recognized += 1;
    const content = isRecord(entry.message) ? entry.message.content : undefined;
    const text = textOfContent(content);
    const at = timestampFrom(entry, text);
    const toolCalls = countToolUses(content);
    const index = turns.length;
    turns.push({
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
      toolCalls,
      sidechain: false,
    });
    for (const touch of touchesFromToolContent(content, at, index)) touches.push(touch);
    if (text === '') continue;
    if (role === 'user') userBits.push(text);
    else assistantBits.push(text);
  }

  const derived = deriveSession(turns, touches, []);
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
    },
    signals: {
      userExcerpt: clipExcerpt(stripTags(userBits.join('\n'))),
      assistantExcerpt: clipExcerpt(stripTags(assistantBits.at(-1) ?? '')),
    },
    dedupeKeys: [],
    usage: null,
  };
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
