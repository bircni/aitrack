import { createReadStream } from 'node:fs';

import { isRecord } from '../data/guards.js';

/**
 * Stream the JSON objects from a JSONL file, one per line.
 *
 * Blank lines, half-written trailing lines (the transcript is appended while
 * it is read), and lines that parse to a non-object are skipped. Each reader
 * keeps only its own per-entry logic.
 */
export async function* streamJsonlObjects(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  let carry = '';
  const input = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  for await (const chunk of input) {
    const piece = typeof chunk === 'string' ? chunk : '';
    const text = carry.length === 0 ? piece : carry + piece;
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) break;
      const parsed = parseLine(text.slice(start, newline));
      if (parsed !== null) yield parsed;
      start = newline + 1;
    }
    carry = text.slice(start);
  }
  if (carry.length > 0) {
    const parsed = parseLine(carry);
    if (parsed !== null) yield parsed;
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  let start = 0;
  while (start < line.length) {
    const code = line.codePointAt(start);
    if (code !== 32 && code !== 9 && code !== 13) break;
    start += 1;
  }
  if (start === line.length) return null;
  const body = start === 0 ? line : line.slice(start);
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A truncated or half-written line — skip it rather than failing the file.
    return null;
  }
}
