import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { parseMachineFile } from '../data/validate.js';
import { runGit } from '../git/exec.js';
import { machineDataFilename, normalizeMachineId } from '../machineId.js';
import { DATA_DIR, PENDING_DATA_DIR } from '../paths.js';
import { machineFilePath } from './machineFiles.js';

/**
 * Renaming a machine's files when its id changes.
 *
 * A transaction with rollback: each file is written before its source is
 * removed, and a failure part-way restores what was already moved.
 */
interface MachineFileMigration {
  source: string;
  target: string;
  sourceContents: string;
  contents: string;
  repositoryPaths?: [string, string];
}

function planMachineFileMigration(
  directory: string,
  previousMachineId: string,
  nextMachineId: string,
): MachineFileMigration | null {
  const source = machineFilePath(directory, previousMachineId);
  if (!existsSync(source)) return null;

  const target = machineFilePath(directory, nextMachineId);
  if (existsSync(target)) {
    throw new Error(
      `Cannot rename machine "${previousMachineId}" to "${nextMachineId}": ${target} already exists.`,
    );
  }

  const sourceContents = readFileSync(source, 'utf8');
  const machine = parseMachineFile(sourceContents, source, {
    allowInconsistentCostTotals: true,
  });
  if (!machine) {
    throw new Error(`Cannot rename machine "${previousMachineId}": ${source} is invalid.`);
  }

  return {
    source,
    target,
    sourceContents,
    contents: JSON.stringify({ ...machine, hostname: nextMachineId }, null, 2),
    repositoryPaths:
      directory === DATA_DIR
        ? [
            `data/${machineDataFilename(previousMachineId)}`,
            `data/${machineDataFilename(nextMachineId)}`,
          ]
        : undefined,
  };
}

function rollbackMachineFileMigration(plan: MachineFileMigration): void {
  writeFileSync(plan.source, plan.sourceContents, { encoding: 'utf8', flag: 'wx' });
  try {
    rmSync(plan.target);
  } catch (error) {
    rmSync(plan.source, { force: true });
    throw error;
  }
}

/** Rename this machine's persisted and pending files without overwriting another machine. */
export function migrateMachineDataFiles(previousId: string, nextId: string): void {
  const previousMachineId = normalizeMachineId(previousId);
  const nextMachineId = normalizeMachineId(nextId);
  if (previousMachineId === nextMachineId) return;

  const plans = [
    planMachineFileMigration(DATA_DIR, previousMachineId, nextMachineId),
    planMachineFileMigration(PENDING_DATA_DIR, previousMachineId, nextMachineId),
  ].filter((plan): plan is MachineFileMigration => plan !== null);

  const completed: MachineFileMigration[] = [];
  try {
    for (const plan of plans) {
      try {
        writeFileSync(plan.target, plan.contents, { encoding: 'utf8', flag: 'wx' });
        rmSync(plan.source);
        completed.push(plan);
      } catch (error) {
        rmSync(plan.target, { force: true });
        throw error;
      }
    }
    for (const plan of plans) {
      if (plan.repositoryPaths === undefined) continue;
      runGit(['add', '--', ...plan.repositoryPaths.map((path) => `:(literal)${path}`)], {
        stdio: 'pipe',
      });
    }
  } catch (error) {
    let rollbackError: unknown;
    for (const plan of completed.reverse()) {
      try {
        rollbackMachineFileMigration(plan);
      } catch (candidate) {
        rollbackError ??= candidate;
      }
    }
    if (rollbackError !== undefined) {
      throw new AggregateError(
        [error, rollbackError],
        'Machine data migration and rollback failed.',
      );
    }
    throw error;
  }
}
