import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { isRecord } from '../data/guards.js';
import { isMissingPathError } from '../errors.js';

/** Stream the JSON objects from a JSONL file, one per line. */
export async function* streamJsonlObjects(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
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
  } catch (error) {
    if (!isMissingPathError(error)) throw error; // Deleted since listing.
  }
}
