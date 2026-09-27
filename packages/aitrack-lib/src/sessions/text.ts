import { isRecord } from '../data/guards.js';
import type { FileTouch, FileTouchKind } from './types.js';

const EXCERPT_LIMIT = 1500;

export function clipExcerpt(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  if (flat.length <= EXCERPT_LIMIT) return flat;
  return flat.slice(0, EXCERPT_LIMIT);
}

let cachedTimestamp = '';
let cachedIso: string | null = null;

export function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value === cachedTimestamp) return cachedIso;
  const fast = canonicalUtcIso(value);
  const parsed = fast ?? parseLooseTimestamp(value);
  cachedTimestamp = value;
  cachedIso = parsed;
  return parsed;
}

function parseLooseTimestamp(value: string): string | null {
  if (value.trim() === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** `YYYY-MM-DDTHH:mm:ss.sssZ` and `YYYY-MM-DDTHH:mm:ssZ` are already UTC. */
function canonicalUtcIso(value: string): string | null {
  const withMillis = value.length === 24;
  if (!withMillis && value.length !== 20) return null;
  if (
    value.codePointAt(4) !== 45 ||
    value.codePointAt(7) !== 45 ||
    value.codePointAt(10) !== 84 ||
    value.codePointAt(13) !== 58 ||
    value.codePointAt(16) !== 58
  ) {
    return null;
  }
  if (withMillis) {
    if (value.codePointAt(19) !== 46 || value.codePointAt(23) !== 90) return null;
  } else if (value.codePointAt(19) !== 90) return null;
  const year = readInt(value, 0, 4);
  const month = readInt(value, 5, 2);
  const day = readInt(value, 8, 2);
  const hour = readInt(value, 11, 2);
  const minute = readInt(value, 14, 2);
  const second = readInt(value, 17, 2);
  if (
    year < 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (!withMillis) return `${value.slice(0, 19)}.000Z`;
  if (readInt(value, 20, 3) < 0) return null;
  return value;
}

function readInt(value: string, start: number, length: number): number {
  let n = 0;
  for (let i = 0; i < length; i += 1) {
    const code = value.codePointAt(start + i);
    if (code === undefined || code < 48 || code > 57) return -1;
    n = n * 10 + (code - 48);
  }
  return n;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

export function fileTouchKind(toolName: string): FileTouchKind {
  const name = toolName.toLowerCase();
  if (name === 'read' || name === 'notebookread') return 'read';
  if (name === 'write' || name === 'create') return 'create';
  if (name === 'delete' || name === 'remove') return 'delete';
  return 'edit';
}

export function touchesFromToolContent(
  content: unknown,
  at: string | null,
  turnIndex: number,
): FileTouch[] {
  if (!Array.isArray(content)) return [];
  const touches: FileTouch[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    const name = typeof block.name === 'string' ? block.name : '';
    const input = isRecord(block.input) ? block.input : {};
    const path = firstPath(input);
    if (path === null) continue;
    touches.push({ path, kind: fileTouchKind(name), at, turnIndex });
  }
  return touches;
}

export function countToolUses(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (isRecord(block) && block.type === 'tool_use') count += 1;
  }
  return count;
}

function firstPath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'notebook_path', 'target_file']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

const SOURCE_FILE = /((?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+)/gu;
const REDIRECT = /(?:>>?)\s*([^\s'"]+)/gu;
const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File: (\S+)/gmu;

/** Paths mentioned by a Codex shell or patch command. Redirect targets count as edits. */
export function pathsInCommand(command: string): Array<{ path: string; kind: FileTouchKind }> {
  const edits = new Set<string>();
  const reads = new Set<string>();
  for (const match of command.matchAll(REDIRECT)) {
    const path = match[1];
    if (path !== undefined && !path.startsWith('&') && path.includes('.')) edits.add(path);
  }
  for (const match of command.matchAll(PATCH_FILE)) {
    const path = match[1];
    if (path !== undefined) edits.add(path);
  }
  for (const match of command.matchAll(SOURCE_FILE)) {
    const path = match[1];
    if (path === undefined || edits.has(path)) continue;
    reads.add(path);
  }
  return [
    ...[...edits].map((path) => ({ path, kind: 'edit' as const })),
    ...[...reads].map((path) => ({ path, kind: 'read' as const })),
  ];
}
