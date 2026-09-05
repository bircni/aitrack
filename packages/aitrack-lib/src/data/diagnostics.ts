import { log } from '../output.js';
import type { MachineFileDiagnostic } from './validate.js';

/**
 * Files already warned about, so a dropped day stays a one-shot per file.
 *
 * Only the current machine self-heals — sync rewrites its own file — so for
 * another machine's file this would otherwise print on every command and every
 * run with nothing the local user could do about it.
 *
 * This lived inside the validator, which made a pure check impure. It belongs
 * with the reporting, since it is a presentation decision.
 */
const warnedDroppedDays = new Set<string>();
/** Files whose migration has already been reported this run — one line each. */

function formatMachineFileDiagnostic(diagnostic: MachineFileDiagnostic): string {
  switch (diagnostic.kind) {
    case 'file-skipped': {
      return `Skipping invalid machine file ${diagnostic.filePath}: ${diagnostic.reason}`;
    }
    case 'day-dropped': {
      return `Dropping day ${diagnostic.date} from machine file ${diagnostic.filePath}: ${diagnostic.reason}`;
    }
  }
}

export function reportMachineFileDiagnostics(diagnostics: MachineFileDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === 'day-dropped') {
      if (warnedDroppedDays.has(diagnostic.filePath)) continue;
      warnedDroppedDays.add(diagnostic.filePath);
    }
    log.warn(formatMachineFileDiagnostic(diagnostic));
  }
}

/** Forget which files have been warned about. Exposed for tests. */
export function resetMachineFileDiagnostics(): void {
  warnedDroppedDays.clear();
}
