import { checkRawMachineFile } from '../data/validate.js';
import { serializeMachineFile } from './machineFiles.js';

/**
 * Both sides of a conflicted machine file as one, or null when either cannot be read. Machine files
 * are per-day ratchets, so this keeps every day from both; encrypted if either side was, so a merge
 * never exposes a file. The header is the replayed commit's, this machine's latest word on its own
 * file; costs of a kept day follow its side until the next recompute.
 */
export async function mergeConflictedMachineFile(
  path: string,
  remoteRaw: string,
  localRaw: string,
): Promise<string | null> {
  const options = { allowInconsistentCostTotals: true };
  const remote = checkRawMachineFile(remoteRaw, path, options);
  const local = checkRawMachineFile(localRaw, path, options);
  if (!remote.machine || !local.machine) return null;
  // Loaded here because it pulls in the readers, which no ordinary git call needs.
  const { mergePersistedDays } = await import('../data/localData.js');
  return serializeMachineFile(
    { ...local.machine, days: mergePersistedDays(remote.machine.days, local.machine.days) },
    remote.encrypted === true || local.encrypted === true,
  );
}
