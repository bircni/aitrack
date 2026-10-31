import { type FileHandle, open } from 'node:fs/promises';

import { isRecord } from '../data/guards.js';
import { isMissingPathError } from '../errors.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Which lines a reader needs. Lines holding none of `needles` (as raw bytes) are
 * never decoded or parsed: in Claude and Codex logs they are most of the bytes.
 */
export interface JsonlFilter {
  needles: readonly string[];
  /**
   * State that skipped lines still carry, such as Claude's `cwd`. A reader may
   * only read it after applying the current record, and a record for which
   * `holds` is true must replace it entirely. Before a record that does not
   * hold, the last skipped line that does is yielded first.
   */
  carry?: { needle: string; holds: (record: Record<string, unknown>) => boolean };
}

interface CompiledFilter {
  needles: Buffer[];
  carry?: { needle: Buffer; holds: (record: Record<string, unknown>) => boolean };
}

function parseLine(view: Buffer, start: number, end: number): Record<string, unknown> | undefined {
  if (start >= end) return undefined;
  try {
    const parsed: unknown = JSON.parse(view.toString('utf8', start, end));
    // A bare number or string parses fine and would otherwise be cast to a shape it never had.
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined; // A truncated or half-written line.
  }
}

function lineStartOf(view: Buffer, index: number): number {
  return index === 0 ? 0 : view.lastIndexOf(NEWLINE, index - 1) + 1; // A negative offset would count from the end.
}

function lineEndOf(view: Buffer, index: number, limit: number): number {
  const end = view.indexOf(NEWLINE, index);
  return end === -1 || end > limit ? limit : end;
}

/** The last line in [from, to) that carries state, parsed. */
function lastCarrier(
  view: Buffer,
  from: number,
  to: number,
  carry: NonNullable<CompiledFilter['carry']>,
): Record<string, unknown> | undefined {
  for (let at = to; at > from;) {
    const hit = view.lastIndexOf(carry.needle, at - 1);
    if (hit < from) return undefined;
    const start = lineStartOf(view, hit);
    const record = parseLine(view, start, lineEndOf(view, hit, to));
    if (record && carry.holds(record)) return record;
    at = start;
  }
  return undefined;
}

function* allLines(view: Buffer): Generator<Record<string, unknown>> {
  for (let start = 0; start < view.length;) {
    const end = lineEndOf(view, start, view.length);
    const record = parseLine(view, start, end);
    if (record) yield record;
    start = end + 1;
  }
}

/** `view` holds whole lines; `isLast` when nothing follows it, so a trailing carrier is moot. */
function* matchingLines(
  view: Buffer,
  filter: CompiledFilter,
  isLast: boolean,
): Generator<Record<string, unknown>> {
  const next = filter.needles.map((needle) => view.indexOf(needle));
  let searchFrom = 0;
  let gapStart = 0;
  for (;;) {
    let hit = -1;
    for (const [index, needle] of filter.needles.entries()) {
      let at = next[index] ?? -1;
      if (at !== -1 && at < searchFrom) {
        at = view.indexOf(needle, searchFrom);
        next[index] = at;
      }
      if (at !== -1 && (hit === -1 || at < hit)) hit = at;
    }
    if (hit === -1) break;

    const start = lineStartOf(view, hit);
    const end = lineEndOf(view, hit, view.length);
    searchFrom = end + 1;
    const record = parseLine(view, start, end);
    if (!record) continue; // Left in the gap, where it carries nothing either.
    const { carry } = filter;
    if (carry && start > gapStart && !carry.holds(record)) {
      const carrier = lastCarrier(view, gapStart, start, carry);
      if (carrier) yield carrier;
    }
    gapStart = searchFrom;
    yield record;
  }
  // The next chunk cannot look back into this one, so its carrier is resolved now.
  if (!isLast && filter.carry && gapStart < view.length) {
    const carrier = lastCarrier(view, gapStart, view.length, filter.carry);
    if (carrier) yield carrier;
  }
}

function compile(filter: JsonlFilter): CompiledFilter {
  return {
    needles: filter.needles.map((needle) => Buffer.from(needle)),
    ...(filter.carry && {
      carry: { needle: Buffer.from(filter.carry.needle), holds: filter.carry.holds },
    }),
  };
}

async function openIfPresent(filePath: string): Promise<FileHandle | undefined> {
  try {
    return await open(filePath, 'r');
  } catch (error) {
    if (isMissingPathError(error)) return undefined; // Deleted since listing.
    throw error;
  }
}

/** Stream the JSON objects from a JSONL file, one per line; with `filter`, only the lines it needs. */
export async function* streamJsonlObjects(
  filePath: string,
  filter?: JsonlFilter,
): AsyncGenerator<Record<string, unknown>> {
  const handle = await openIfPresent(filePath);
  if (!handle) return;
  const compiled = filter && compile(filter);
  try {
    const { size } = await handle.stat();
    let buffer = Buffer.allocUnsafe(Math.min(Math.max(size + 1, 1024), CHUNK_BYTES));
    let filled = 0;
    for (let isLast = false; !isLast;) {
      if (filled === buffer.length) {
        const grown = Buffer.allocUnsafe(buffer.length * 2); // One line longer than the buffer.
        buffer.copy(grown, 0, 0, filled);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      filled += bytesRead;
      isLast = bytesRead === 0;
      if (!isLast && filled < buffer.length) continue; // Fill the chunk, so a file that fits is one pass.
      const end = isLast ? filled : buffer.lastIndexOf(NEWLINE, filled - 1) + 1;
      if (end === 0) continue;
      const view = buffer.subarray(0, end);
      yield* compiled ? matchingLines(view, compiled, isLast) : allLines(view);
      buffer.copyWithin(0, end, filled);
      filled -= end;
    }
  } finally {
    await handle.close();
  }
}
