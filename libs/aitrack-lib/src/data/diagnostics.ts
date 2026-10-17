import { log } from '../output.js';
import type { MachineFileDiagnostic } from './validate.js';

// Warn once per file: other machines' files cannot self-heal, so this would repeat on every run.
const warnedDroppedDays = new Set<string>();

function formatMachineFileDiagnostic(diagnostic: MachineFileDiagnostic): string {
  switch (diagnostic.kind) {
    case 'file-skipped': {
      return `Skipping invalid machine file ${diagnostic.filePath}: ${diagnostic.reason}`;
    }
    case 'day-dropped': {
      return `Dropping day ${diagnostic.date} from machine file ${diagnostic.filePath}: ${diagnostic.reason}`;
    }
    case 'projects-dropped': {
      return `Ignoring the project split of ${diagnostic.date} (${diagnostic.providerKey}) in machine file ${diagnostic.filePath}: ${diagnostic.reason}`;
    }
    default: {
      const _exhaustive: never = diagnostic;
      throw new Error(`Unhandled machine-file diagnostic: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function reportMachineFileDiagnostics(diagnostics: MachineFileDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind !== 'file-skipped') {
      if (warnedDroppedDays.has(diagnostic.filePath)) continue;
      warnedDroppedDays.add(diagnostic.filePath);
    }
    log.warn(formatMachineFileDiagnostic(diagnostic));
  }
}
