import { execFileSync } from 'node:child_process';

import { readConfig, resolveMachineId, type ConfigLoad } from 'aitrack-lib/config';
import { findDuplicateMachineDays } from 'aitrack-lib/data/duplicateMachines';
import type { MachineFile } from 'aitrack-lib/data/types';
import { isCloned, listDataFiles, LOCAL_REPO, readDataFile } from 'aitrack-lib/git';
import { PROVIDERS, type CheckResult } from 'aitrack-lib/providers/index';

/**
 * Local health checks for Settings. This does not run `git push` or `git status`.
 */
export async function collectDoctorChecks(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [
    runtimeCheck(),
    gitCheck(),
    configCheck(readConfig()),
    dataRepoCheck(),
  ];
  if (isCloned()) checks.push(machineCheck());
  const providers = await Promise.all(PROVIDERS.map((provider) => providerCheck(provider)));
  checks.push(...providers);
  return checks;
}

function runtimeCheck(): CheckResult {
  const major = Number(process.versions.node.split('.', 1)[0] ?? 0);
  return {
    status: major >= 24 ? 'ok' : 'fail',
    label: 'Node.js',
    detail: `${process.version} (requires 24 or newer)`,
  };
}

function gitCheck(): CheckResult {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
    return { status: 'ok', label: 'git', detail: 'Available on PATH' };
  } catch {
    return { status: 'fail', label: 'git', detail: 'git is not available on PATH' };
  }
}

function configCheck(loaded: ConfigLoad): CheckResult {
  switch (loaded.status) {
    case 'ok': {
      return {
        status: 'ok',
        label: 'Config',
        detail: `Data repo ${loaded.config.repoUrl}, machine ${resolveMachineId(loaded.config)}`,
      };
    }
    case 'invalid': {
      return {
        status: 'fail',
        label: 'Config',
        detail: `The config file is ${loaded.reason}.`,
      };
    }
    case 'missing': {
      return {
        status: 'warn',
        label: 'Config',
        detail: 'No config yet. Connect a data repo here if you want sync.',
      };
    }
    default: {
      const neverStatus: never = loaded;
      return neverStatus;
    }
  }
}

function dataRepoCheck(): CheckResult {
  if (!isCloned()) {
    return { status: 'warn', label: 'Data repo', detail: 'No local clone yet.' };
  }
  return { status: 'ok', label: 'Data repo', detail: LOCAL_REPO };
}

function machineCheck(): CheckResult {
  const machines = listDataFiles()
    .map((filePath) => readDataFile(filePath))
    .filter((machine): machine is MachineFile => machine !== null);
  const duplicates = findDuplicateMachineDays(machines);
  if (duplicates.days.length === 0) {
    return {
      status: 'ok',
      label: 'Machine identities',
      detail: `${String(machines.length)} machine file(s), no duplicated days`,
    };
  }
  return {
    status: 'warn',
    label: 'Machine identities',
    detail: `${String(duplicates.days.length)} day(s) are stored under more than one machine (${duplicates.machines.join(', ')}).`,
  };
}

async function providerCheck(provider: (typeof PROVIDERS)[number]): Promise<CheckResult> {
  try {
    return await provider.doctorCheck();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Check failed';
    return { status: 'fail', label: provider.descriptor.label, detail: message };
  }
}
