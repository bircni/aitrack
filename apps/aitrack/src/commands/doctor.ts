import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { type ConfigLoad, readConfig, resolveMachineId } from 'aitrack-lib/config';
import { findDuplicateMachineDays } from 'aitrack-lib/data/duplicateMachines';
import { isRecord } from 'aitrack-lib/data/guards';
import { INIT_HINT } from 'aitrack-lib/data/messages';
import { pad } from 'aitrack-lib/display/format';
import { errorMessage } from 'aitrack-lib/errors';
import { isCloned, listDataFiles, LOCAL_REPO, readDataFile } from 'aitrack-lib/git';
import { GitCommandError, isRebaseInProgress, runGitAsync } from 'aitrack-lib/git/exec';
import { differingOrigin, originMismatchMessage, redactUrl } from 'aitrack-lib/git/remote';
import { log } from 'aitrack-lib/output';
import {
  type CheckResult,
  type CheckStatus,
  type Provider,
  PROVIDERS,
} from 'aitrack-lib/providers/index';
import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';

const GIT_CHECK_TIMEOUT_MS = 10_000;

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
    status: result.failed || result.unverified ? 'warn' : 'ok',
    label: 'Pricing cache',
    detail: `${String(pricing.claudeModelCount())} Claude, ${String(pricing.codexModelCount())} Codex, ${String(pricing.cursorModelCount())} Cursor — ${result.detail} (updatedAt ${result.updatedAt})${result.unverified ? '; pack has no checksums, content not verified' : ''}`,
  };
}

function pricingCheck(): CheckResult {
  // The script exists only in a source checkout; elsewhere bun would fail confusingly.
  if (!isAitrackCheckout(process.cwd())) {
    return {
      status: 'warn',
      label: 'Pricing drift',
      detail:
        'not an aitrack source checkout; run doctor --pricing-check from the aitrack repo root',
    };
  }

  const run = runCommand('bun', ['run', 'pricing:check'], process.cwd());
  return run.ok
    ? { status: 'ok', label: 'Pricing drift', detail: 'bun run pricing:check passed' }
    : {
        status: 'warn',
        label: 'Pricing drift',
        detail: run.output
          ? `bun run pricing:check failed: ${run.output}`
          : 'bun run pricing:check did not pass; run from the aitrack repo root and inspect its output',
      };
}

export function duplicateMachineCheck(): CheckResult {
  const unreadable: string[] = [];
  const machines = listDataFiles().flatMap((filePath) => {
    const machine = readDataFile(filePath);
    if (machine === null) unreadable.push(basename(filePath));
    return machine === null ? [] : [machine];
  });
  if (unreadable.length > 0) {
    return {
      status: 'warn',
      label: 'Machine identities',
      detail: `skipped unreadable machine file(s), left out of every report: ${unreadable.join(', ')}`,
    };
  }

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
      detail: `repoUrl=${redactUrl(loaded.config.repoUrl) || '(empty)'}, machineId=${resolveMachineId(loaded.config)}`,
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

/** `git` errors carry the command; these details name it in their own words. */
async function gitCheck(
  label: string,
  args: string[],
  failStatus: CheckStatus,
  okDetail: string,
  failed: (output: string) => string,
): Promise<CheckResult> {
  try {
    await runGitAsync(args, { timeoutMs: GIT_CHECK_TIMEOUT_MS });
    return { status: 'ok', label, detail: okDetail };
  } catch (error) {
    const output = error instanceof GitCommandError ? error.output : errorMessage(error);
    return { status: failStatus, label, detail: failed(output) };
  }
}

function originCheck(loaded: ConfigLoad): CheckResult[] {
  if (loaded.status !== 'ok') return [];
  const origin = differingOrigin(loaded.config.repoUrl);
  if (origin === null) return [];
  return [
    {
      status: 'warn',
      label: 'Remote',
      detail: originMismatchMessage(origin, loaded.config.repoUrl),
    },
  ];
}

function rebaseCheck(): CheckResult[] {
  if (!isRebaseInProgress()) return [];
  return [
    {
      status: 'warn',
      label: 'Rebase',
      detail: `an interrupted rebase is in progress in ${LOCAL_REPO}; the next sync aborts it`,
    },
  ];
}

async function collectChecks(options: DoctorOptions): Promise<CheckResult[]> {
  const loadedConfig = readConfig();
  const checks: CheckResult[] = [];

  checks.push({
    status: parseMajor(process.versions.node) >= 24 ? 'ok' : 'fail',
    label: 'Node.js',
    detail: `${process.version} (requires >=24)`,
  });
  // Not runGit: that one runs inside the clone, which may not exist yet.
  const isGitAvailable = runCommand('git', ['--version']).ok;
  checks.push({
    status: isGitAvailable ? 'ok' : 'fail',
    label: 'git',
    detail: isGitAvailable ? 'available on PATH' : 'not available on PATH',
  });
  checks.push(configCheck(loadedConfig));
  const isRepoCloned = isCloned();
  checks.push({
    status: isRepoCloned ? 'ok' : 'warn',
    label: 'Local repo',
    detail: isRepoCloned ? LOCAL_REPO : 'not cloned; local preview still works',
  });

  if (isRepoCloned) {
    checks.push(duplicateMachineCheck(), ...originCheck(loadedConfig), ...rebaseCheck());
  }

  // Independent, so a slow network costs its longest wait rather than the sum.
  const [repoChecks, providerChecks, pricing] = await Promise.all([
    isRepoCloned
      ? Promise.all([
          gitCheck('Repo health', ['status', '--short'], 'fail', 'git status succeeded', (output) =>
            output ? `git status failed: ${output}` : 'git status failed in local repo',
          ),
          gitCheck(
            'Remote push',
            ['push', '--dry-run'],
            'warn',
            'git push --dry-run succeeded',
            (output) =>
              output
                ? `git push --dry-run failed: ${output}`
                : 'git push --dry-run failed; check remote access and branch tracking',
          ),
        ])
      : [],
    Promise.all(PROVIDERS.map((provider) => providerCheck(provider))),
    pricingCacheCheck(),
  ]);
  checks.push(...repoChecks, ...providerChecks, pricing);
  if (options.pricingCheck) checks.push(pricingCheck());

  return checks;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  const checks = await collectChecks(options);
  const hasFailures = checks.some((check) => check.status === 'fail');

  if (options.json) {
    printJsonCommand('doctor', { checks, hasFailures });
  } else {
    log.info(chalk.bold('aitrack doctor'));
    for (const check of checks) {
      log.info(`${statusLabel(check.status)}  ${check.label}: ${check.detail}`);
    }
  }

  if (hasFailures) process.exitCode = 1;
}
