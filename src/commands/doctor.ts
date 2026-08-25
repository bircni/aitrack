import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';
import { type ConfigLoad, readConfig, resolveMachineId } from '../config.js';
import { findDuplicateMachineDays } from '../data/duplicateMachines.js';
import { isRecord } from '../data/guards.js';
import { INIT_HINT } from '../data/messages.js';
import type { MachineFile } from '../data/types.js';
import { pad } from '../display/format.js';
import { errorMessage } from '../errors.js';
import { isCloned, listDataFiles, LOCAL_REPO, readDataFile } from '../git.js';
import { log } from '../output.js';
import { CLAUDE_PRICING_BY_ID } from '../pricing/claude.js';
import { CODEX_PRICING_BY_ID } from '../pricing/codex.js';
import { getClaudePaths } from '../readers/claude.js';
import { getCodexPaths } from '../readers/codex.js';
import { getCursorStateDatabasePath, readCursorAuthState } from '../readers/cursor/auth.js';
import { jsonlSourceSummary } from '../readers/paths.js';

interface DoctorOptions {
  pricingCheck?: boolean;
  json?: boolean;
}

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
  status: CheckStatus;
  label: string;
  detail: string;
}

/**
 * Status text and its color, kept apart so the column can be padded on the
 * plain text.
 *
 * Padding the colored string instead measured the ANSI escapes as content, so
 * `padEnd` was a no-op on a TTY and the columns only lined up when color was
 * disabled. `display/terminalTable.ts` already pads before styling.
 */
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

async function sourceCheck(label: string, roots: string[]): Promise<CheckResult> {
  const { existing, fileCount } = await jsonlSourceSummary(roots);
  if (fileCount > 0) {
    return {
      status: 'ok',
      label,
      detail: `${String(fileCount)} JSONL file(s) across ${String(existing.length)} existing path(s)`,
    };
  }
  if (existing.length > 0) {
    return {
      status: 'warn',
      label,
      detail: `paths exist but no JSONL files were found: ${existing.join(', ')}`,
    };
  }
  return {
    status: 'warn',
    label,
    detail: `no source paths found; checked ${roots.join(', ')}`,
  };
}

/** Whether `directory` is the aitrack repo, which is what carries the script. */
function isAitrackCheckout(directory: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (!isRecord(parsed)) return false;
    return (
      parsed.name === 'aitrack' && isRecord(parsed.scripts) && 'pricing:check' in parsed.scripts
    );
  } catch {
    return false;
  }
}

function pricingCheck(options: DoctorOptions): CheckResult {
  if (!options.pricingCheck) {
    return {
      status: 'ok',
      label: 'Pricing tables',
      detail: `${String(Object.keys(CLAUDE_PRICING_BY_ID).length)} Claude and ${String(
        Object.keys(CODEX_PRICING_BY_ID).length,
      )} Codex model entries bundled; run doctor --pricing-check for drift check`,
    };
  }

  // The drift check shells out to `pnpm run pricing:check`, which only exists
  // in a source checkout. A published install has neither the script nor
  // necessarily pnpm, and any unrelated project's package.json would previously
  // get this far and fail with a confusing pnpm error.
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

async function cursorCheck(): Promise<CheckResult> {
  const stateDb = getCursorStateDatabasePath();
  if (!stateDb) {
    return {
      status: 'warn',
      label: 'Cursor source',
      detail: 'state.vscdb not found; Cursor usage will be skipped unless configured',
    };
  }

  try {
    const auth = await readCursorAuthState(stateDb);
    return auth.accessToken
      ? { status: 'ok', label: 'Cursor source', detail: `auth token found in ${stateDb}` }
      : {
          status: 'warn',
          label: 'Cursor source',
          detail: `state DB found but no access token was present: ${stateDb}`,
        };
  } catch (error) {
    const message = errorMessage(error);
    return { status: 'warn', label: 'Cursor source', detail: message };
  }
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

/**
 * Report the config, distinguishing a file that is absent from one that is
 * present but broken — which used to look identical here, so a corrupt config
 * was diagnosed as "no config found" and the advice was to re-run init.
 */
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
  checks.push({
    status: isCloned() ? 'ok' : 'warn',
    label: 'Local repo',
    detail: isCloned() ? LOCAL_REPO : 'not cloned; local preview still works',
  });

  if (isCloned()) {
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

  // Three independent probes that each hit the filesystem or Cursor's database.
  checks.push(
    ...(await Promise.all([
      sourceCheck('Claude Code source', getClaudePaths()),
      sourceCheck('Codex source', getCodexPaths()),
      cursorCheck(),
    ])),
  );
  checks.push(pricingCheck(options));

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
