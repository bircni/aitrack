import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ConfigLoad, readConfig, resolveMachineId } from 'aitrack-lib/config';
import { findDuplicateMachineDays } from 'aitrack-lib/data/duplicateMachines';
import { isRecord } from 'aitrack-lib/data/guards';
import { INIT_HINT } from 'aitrack-lib/data/messages';
import type { MachineFile } from 'aitrack-lib/data/types';
import { pad } from 'aitrack-lib/display/format';
import { errorMessage } from 'aitrack-lib/errors';
import { isCloned, listDataFiles, LOCAL_REPO, readDataFile } from 'aitrack-lib/git';
import { log } from 'aitrack-lib/output';
import {
  type CheckResult,
  type CheckStatus,
  type Provider,
  PROVIDERS,
} from 'aitrack-lib/providers/index';
import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';

interface DoctorOptions {
  pricingCheck?: boolean;
  json?: boolean;
}

/** Kept apart from the color so the column is padded on the plain text. */
const STATUS_STYLE: Record<CheckStatus, { text: string; color: (value: string) => string }> = {
  ok: { text: 'OK', color: (value) => chalk.green(value) },
  warn: { text: 'WARN', color: (value) => chalk.yellow(value) },
  fail: { text: 'FAIL', color: (value) => chalk.red(value) },
};

/** Width of the widest status text, so every row's label starts in one column. */
const STATUS_COLUMN_WIDTH = 4;

function statusLabel(status: CheckStatus): string {
  const style = STATUS_STYLE[status];
  return style.color(pad(style.text, STATUS_COLUMN_WIDTH, 'left'));
}

function parseMajor(version: string): number {
  return Number(version.split('.', 1)[0] ?? 0);
}

interface CommandRunResult {
  ok: boolean;
  output: string;
}

function runCommand(command: string, arguments_: string[], cwd?: string): CommandRunResult {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10_000,
  });
  const output = [result.stderr, result.stdout]
    .filter((chunk): chunk is string => typeof chunk === 'string' && chunk.trim().length > 0)
    .join('\n')
    .trim();
  return { ok: result.status === 0, output };
}

function commandCheck(
  label: string,
  command: string,
  arguments_: string[],
  options: {
    cwd?: string;
    okStatus?: CheckStatus;
    failStatus?: CheckStatus;
    okDetail: string | ((output: string) => string);
    failDetail: string | ((output: string) => string);
  },
): CheckResult {
  const run = runCommand(command, arguments_, options.cwd);
  const detail = run.ok
    ? typeof options.okDetail === 'function'
      ? options.okDetail(run.output)
      : options.okDetail
    : typeof options.failDetail === 'function'
      ? options.failDetail(run.output)
      : options.failDetail;
  return {
    status: run.ok ? (options.okStatus ?? 'ok') : (options.failStatus ?? 'fail'),
    label,
    detail,
  };
}

/** Whether `directory` is the aitrack repo, which is what carries the script. */
function isAitrackCheckout(directory: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (!isRecord(parsed)) return false;
    return (
      parsed.name === 'aitrack-workspace' &&
      isRecord(parsed.scripts) &&
      'pricing:check' in parsed.scripts
    );
  } catch {
    return false;
  }
}

async function pricingCacheCheck(): Promise<CheckResult> {
  const { syncPricingPack } = await import('aitrack-lib/pricing/syncPack');
  const { currentModelPricing } = await import('aitrack-lib/pricing/store');
  const result = await syncPricingPack();
  const pricing = currentModelPricing();
  return {
    status: result.failed ? 'warn' : 'ok',
    label: 'Pricing cache',
    detail: `${String(pricing.claudeModelCount())} Claude, ${String(pricing.codexModelCount())} Codex, ${String(pricing.cursorModelCount())} Cursor — ${result.detail} (updatedAt ${result.updatedAt})`,
  };
}

function pricingCheck(): CheckResult {
  // The script exists only in a source checkout; elsewhere pnpm would fail confusingly.
  if (!isAitrackCheckout(process.cwd())) {
    return {
      status: 'warn',
      label: 'Pricing drift',
      detail:
        'not an aitrack source checkout; run doctor --pricing-check from the aitrack repo root',
    };
  }

  const run = runCommand('pnpm', ['run', 'pricing:check'], process.cwd());
  return run.ok
    ? { status: 'ok', label: 'Pricing drift', detail: 'pnpm run pricing:check passed' }
    : {
        status: 'warn',
        label: 'Pricing drift',
        detail: run.output
          ? `pnpm run pricing:check failed: ${run.output}`
          : 'pnpm run pricing:check did not pass; run from the aitrack repo root and inspect its output',
      };
}

// One physical machine synced under two identities (e.g. after a hostname or
// machineId change that left the old data file behind) gets counted twice in
// every aggregate. The tell is the same day carrying a byte-identical payload
// under more than one machine file — real distinct machines never collide.
export function duplicateMachineCheck(): CheckResult {
  const machines = listDataFiles()
    .map((filePath) => readDataFile(filePath))
    .filter((machine): machine is MachineFile => machine !== null);

  const duplicates = findDuplicateMachineDays(machines);
  if (duplicates.days.length === 0) {
    return {
      status: 'ok',
      label: 'Machine identities',
      detail: `${String(machines.length)} machine(s), no duplicated days`,
    };
  }

  return {
    status: 'warn',
    label: 'Machine identities',
    detail:
      `${String(duplicates.days.length)} day(s) are recorded identically under multiple machines (${duplicates.machines.join(', ')}) — ` +
      'totals are inflated. These are likely one machine synced under several ids; ' +
      'merge them into one data file.',
  };
}

function configCheck(loaded: ConfigLoad): CheckResult {
  if (loaded.status === 'ok') {
    return {
      status: 'ok',
      label: 'Config',
      detail: `repoUrl=${loaded.config.repoUrl || '(empty)'}, machineId=${resolveMachineId(loaded.config)}`,
    };
  }
  if (loaded.status === 'invalid') {
    return {
      status: 'fail',
      label: 'Config',
      detail: `config file is ${loaded.reason}; fix it or re-run ${INIT_HINT}`,
    };
  }
  return {
    status: 'warn',
    label: 'Config',
    detail: `no config found; run ${INIT_HINT} for sync`,
  };
}

async function providerCheck(provider: Provider): Promise<CheckResult> {
  try {
    return await provider.doctorCheck();
  } catch (error) {
    // An unreadable source folder (EACCES) is one bad row, not a crashed doctor.
    return {
      status: 'warn',
      label: `${provider.descriptor.label} source`,
      detail: errorMessage(error),
    };
  }
}

async function collectChecks(options: DoctorOptions): Promise<CheckResult[]> {
  const loadedConfig = readConfig();
  const checks: CheckResult[] = [];

  checks.push({
    status: parseMajor(process.versions.node) >= 24 ? 'ok' : 'fail',
    label: 'Node.js',
    detail: `${process.version} (requires >=24)`,
  });
  checks.push(
    commandCheck('git', 'git', ['--version'], {
      okDetail: 'available on PATH',
      failDetail: 'not available on PATH',
    }),
  );
  checks.push(configCheck(loadedConfig));
  const isRepoCloned = isCloned();
  checks.push({
    status: isRepoCloned ? 'ok' : 'warn',
    label: 'Local repo',
    detail: isRepoCloned ? LOCAL_REPO : 'not cloned; local preview still works',
  });

  if (isRepoCloned) {
    checks.push(duplicateMachineCheck());
    checks.push(
      commandCheck('Repo health', 'git', ['status', '--short'], {
        cwd: LOCAL_REPO,
        okDetail: 'git status succeeded',
        failDetail: (output) =>
          output ? `git status failed: ${output}` : 'git status failed in local repo',
      }),
    );
    checks.push(
      commandCheck('Remote push', 'git', ['push', '--dry-run'], {
        cwd: LOCAL_REPO,
        okStatus: 'ok',
        failStatus: 'warn',
        okDetail: 'git push --dry-run succeeded',
        failDetail: (output) =>
          output
            ? `git push --dry-run failed: ${output}`
            : 'git push --dry-run failed; check remote access and branch tracking',
      }),
    );
  }

  checks.push(...(await Promise.all(PROVIDERS.map((provider) => providerCheck(provider)))));
  checks.push(await pricingCacheCheck());
  if (options.pricingCheck) checks.push(pricingCheck());

  return checks;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  const checks = await collectChecks(options);

  if (options.json) {
    printJsonCommand('doctor', {
      checks: checks.map((check) => ({
        status: check.status,
        label: check.label,
        detail: check.detail,
      })),
      hasFailures: checks.some((check) => check.status === 'fail'),
    });
  } else {
    log.info(chalk.bold('aitrack doctor'));
    for (const check of checks) {
      log.info(`${statusLabel(check.status)}  ${check.label}: ${check.detail}`);
    }
  }

  if (checks.some((check) => check.status === 'fail')) {
    process.exitCode = 1;
  }
}
