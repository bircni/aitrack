import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write-then-rename, so a concurrent reader never sees a half-written file. */
export function writeFileAtomic(path: string, contents: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, contents, 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
