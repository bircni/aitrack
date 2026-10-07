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
import { basename, dirname, join } from 'node:path';

import type { MachineFile } from '../data/types.js';
import { type MachineFileValidationOptions, parseMachineFile } from '../data/validate.js';
import { machineDataFilename, machineIdValidationError } from '../machineId.js';
import { log } from '../output.js';
import { DATA_DIR, PENDING_DATA_DIR } from '../paths.js';

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

export function readDataFile(
  filePath: string,
  options?: MachineFileValidationOptions,
): MachineFile | null {
  return parseMachineFile(readFileSync(filePath, 'utf8'), filePath, options);
}

/** Serialize a machine file the way every writer must, so round-trips stay stable. */
export function serializeMachineFile(machine: MachineFile): string {
  return JSON.stringify(machine, null, 2);
}

/** Write a machine file, creating its parent directory if needed. */
export function writeMachineFile(filePath: string, machine: MachineFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeMachineFile(machine), 'utf8');
}

export function writePendingMachineFile(machine: MachineFile): void {
  writeMachineFile(machineFilePath(PENDING_DATA_DIR, machine.hostname), machine);
}

export function listPendingDataFiles(): string[] {
  if (!existsSync(PENDING_DATA_DIR)) return [];
  const files: string[] = [];
  for (const f of readdirSync(PENDING_DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    // Check the entry name as read, before join() can rewrite it. A `..\`
    // prefix is an ordinary character run on POSIX but a real traversal on
    // Windows, where join() resolves it to a path outside this directory and
    // leaves basename() a clean name that passes every later check.
    const machineId = f.slice(0, -'.json'.length);
    const error = machineIdValidationError(machineId);
    if (error !== null || machineId.trim() !== machineId) {
      log.warn(
        `Skipping staged data file with an invalid name: ${f}${error === null ? '' : ` (${error})`}`,
      );
      continue;
    }
    files.push(join(PENDING_DATA_DIR, f));
  }
  return files;
}

export function adoptPendingDataFiles(targetDataDir: string): number {
  const pending = listPendingDataFiles();
  if (pending.length === 0) return 0;
  mkdirSync(targetDataDir, { recursive: true });

  const copies: Array<{ source: string; target: string }> = [];
  const skipped: string[] = [];
  for (const source of pending) {
    const filename = basename(source);
    const target = join(targetDataDir, filename);
    // Synced data supersedes the staged copy; aborting would leave init unrecoverable.
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
    // Kept: the synced file is not necessarily a superset of what was staged.
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
