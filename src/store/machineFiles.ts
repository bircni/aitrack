import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import type { MachineFile } from '../data/types.js';
import { parseMachineFile } from '../data/validate.js';
import { machineDataFilename, normalizeMachineId } from '../machineId.js';
import { log } from '../output.js';
import { DATA_DIR, PENDING_DATA_DIR } from '../paths.js';

/**
 * Reading and writing the machine JSON files.
 *
 * This is filesystem I/O, not git — it lived in `src/git.ts` only because the
 * files happen to sit inside the clone, which is why that module had to import
 * the validator.
 */
/** Path of a machine's JSON file inside `directory`. */
export function machineFilePath(directory: string, machineId: string): string {
  return join(directory, machineDataFilename(machineId));
}

export function listDataFiles(): string[] {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => join(DATA_DIR, f));
}

export function readDataFile(filePath: string): MachineFile | null {
  const raw = readFileSync(filePath, 'utf8');
  return parseMachineFile(raw, filePath);
}

export function writePendingMachineFile(machine: MachineFile): void {
  const filePath = machineFilePath(PENDING_DATA_DIR, machine.hostname);
  mkdirSync(PENDING_DATA_DIR, { recursive: true });
  writeFileSync(filePath, JSON.stringify(machine, null, 2), 'utf8');
}

export function listPendingDataFiles(): string[] {
  if (!existsSync(PENDING_DATA_DIR)) return [];
  return readdirSync(PENDING_DATA_DIR)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => {
      // Check the entry name as read, before join() can rewrite it. A `..\`
      // prefix is an ordinary character run on POSIX but a real traversal on
      // Windows, where join() resolves it to a path outside this directory and
      // leaves basename() a clean name that passes every later check.
      normalizeMachineId(f.slice(0, -'.json'.length));
      return join(PENDING_DATA_DIR, f);
    });
}

export function adoptPendingDataFiles(targetDataDir: string): number {
  const pending = listPendingDataFiles();
  if (pending.length === 0) return 0;
  mkdirSync(targetDataDir, { recursive: true });

  const copies: Array<{ source: string; target: string }> = [];
  const skipped: string[] = [];
  for (const source of pending) {
    const filename = basename(source);
    const machineId = filename.slice(0, -'.json'.length);
    if (normalizeMachineId(machineId) !== machineId) {
      throw new Error(`Cannot adopt pending machine file with an invalid name: ${filename}`);
    }
    const target = machineFilePath(targetDataDir, machineId);
    // The repo already holds synced data for this machine, which supersedes the
    // staged copy. Leave it alone rather than aborting the whole adoption —
    // throwing here used to make init unrecoverable once a stale staged file
    // existed, since init is also the only way to write the config back.
    if (existsSync(target)) {
      skipped.push(filename);
      continue;
    }
    copies.push({ source, target });
  }

  for (const { source, target } of copies) {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    try {
      rmSync(source);
    } catch (error) {
      rmSync(target, { force: true });
      throw error;
    }
  }
  if (skipped.length > 0) {
    // The skipped sources stay put — a synced file for the machine exists, but
    // it is not necessarily a superset of what was staged, so deleting them
    // here could drop history. Name the directory instead: nothing else clears
    // it, so this warning repeats on every init until the user does.
    log.warn(
      `Skipped ${String(skipped.length)} staged data file(s) already synced in the repo: ${skipped.join(', ')}`,
    );
    log.warn(`  Kept in ${PENDING_DATA_DIR} — delete them once the synced data looks complete.`);
  } else {
    rmSync(PENDING_DATA_DIR, { recursive: true, force: true });
  }
  return copies.length;
}

export function removePendingMachineFile(machineId: string): void {
  const filePath = machineFilePath(PENDING_DATA_DIR, machineId);
  if (existsSync(filePath)) rmSync(filePath);
}
