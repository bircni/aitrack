import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';

import { resolveMachineId, tryLoadConfig } from '../config.js';
import { isCloned, LOCAL_REPO } from '../git.js';
import { CLAUDE_PRICING_BY_ID } from '../pricing/claude.js';
import { CODEX_PRICING_BY_ID } from '../pricing/codex.js';
import { getClaudePaths } from '../readers/claude.js';
import { getCodexPaths } from '../readers/codex.js';
import { getCursorStateDbPath, readCursorAuthState } from '../readers/cursor/auth.js';
import { jsonlSourceSummary } from '../readers/paths.js';

interface DoctorOptions {
  pricingCheck?: boolean;
}

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
  status: CheckStatus;
  label: string;
  detail: string;
}

function statusLabel(status: CheckStatus): string {
  if (status === 'ok') return chalk.green('OK');
  if (status === 'warn') return chalk.yellow('WARN');
  return chalk.red('FAIL');
}

function parseMajor(version: string): number {
  return Number(version.split('.', 1)[0] ?? 0);
}

function commandWorks(command: string, arguments_: string[], cwd?: string): boolean {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10_000,
  });
  return result.status === 0;
}

function commandCheck(
  label: string,
  command: string,
  arguments_: string[],
  options: {
    cwd?: string;
    okStatus?: CheckStatus;
    failStatus?: CheckStatus;
    okDetail: string;
    failDetail: string;
  },
): CheckResult {
  const ok = commandWorks(command, arguments_, options.cwd);
  return {
    status: ok ? (options.okStatus ?? 'ok') : (options.failStatus ?? 'fail'),
    label,
    detail: ok ? options.okDetail : options.failDetail,
  };
}

function sourceCheck(label: string, roots: string[]): CheckResult {
  const { existing, fileCount } = jsonlSourceSummary(roots);
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

  const packagePath = join(process.cwd(), 'package.json');
  if (!existsSync(packagePath)) {
    return {
      status: 'warn',
      label: 'Pricing drift',
      detail: 'package.json not found in current directory; skipping pnpm run pricing:check',
    };
  }

  const ok = commandWorks('pnpm', ['run', 'pricing:check'], process.cwd());
  return ok
    ? { status: 'ok', label: 'Pricing drift', detail: 'pnpm run pricing:check passed' }
    : {
        status: 'warn',
        label: 'Pricing drift',
        detail: 'pnpm run pricing:check did not pass; inspect its output from the repo root',
      };
}

async function cursorCheck(): Promise<CheckResult> {
  const stateDb = getCursorStateDbPath();
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
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'warn', label: 'Cursor source', detail: message };
  }
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  const config = tryLoadConfig();
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
  checks.push({
    status: config ? 'ok' : 'warn',
    label: 'Config',
    detail: config
      ? `repoUrl=${config.repoUrl || '(empty)'}, machineId=${resolveMachineId(config)}`
      : 'no config found; run npx aitrack init for sync',
  });
  checks.push({
    status: isCloned() ? 'ok' : 'warn',
    label: 'Local repo',
    detail: isCloned() ? LOCAL_REPO : 'not cloned; local preview still works',
  });

  if (isCloned()) {
    checks.push(
      commandCheck('Repo health', 'git', ['status', '--short'], {
        cwd: LOCAL_REPO,
        okDetail: 'git status succeeded',
        failDetail: 'git status failed',
      }),
    );
    checks.push(
      commandCheck('Remote push', 'git', ['push', '--dry-run'], {
        cwd: LOCAL_REPO,
        okStatus: 'ok',
        failStatus: 'warn',
        okDetail: 'checked with git push --dry-run',
        failDetail: 'checked with git push --dry-run',
      }),
    );
  }

  checks.push(sourceCheck('Claude Code source', getClaudePaths()));
  checks.push(sourceCheck('Codex source', getCodexPaths()));
  checks.push(await cursorCheck());
  checks.push(pricingCheck(options));

  console.log(chalk.bold('aitrack doctor'));
  for (const check of checks) {
    console.log(`${statusLabel(check.status).padEnd(9)} ${check.label}: ${check.detail}`);
  }

  if (checks.some((check) => check.status === 'fail')) {
    process.exitCode = 1;
  }
}
