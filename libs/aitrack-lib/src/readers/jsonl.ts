import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { isRecord } from '../data/guards.js';

/**
 * Stream the JSON objects from a JSONL file, one per line.
 *
 * Both the Claude and Codex readers opened the same read stream, the same
 * `createInterface({ crlfDelay: Infinity })`, and skipped blank lines,
 * half-written lines (the transcript is appended to while it is read), and
 * lines that parse to a non-object. That boilerplate lives here now; each
 * reader keeps only its own per-entry logic.
 */
export async function* streamJsonlObjects(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated or half-written line — skip it rather than failing the file.
      continue;
    }
    // A bare number or string parses fine and would otherwise be cast to a
    // shape it never had.
    if (!isRecord(parsed)) continue;
    yield parsed;
  }
}
