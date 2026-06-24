import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function resolveCliEntry(): { command: string; prefixArgs: string[] } {
  const smokeCli = process.env.SMOKE_CLI;
  if (smokeCli !== undefined && smokeCli.length > 0) {
    const entry = join(repoRoot, smokeCli);
    if (!existsSync(entry)) {
      throw new Error(`SMOKE_CLI not found: ${entry}`);
    }
    return { command: 'node', prefixArgs: [entry] };
  }
  return { command: 'pnpm', prefixArgs: ['exec', 'tsx', 'src/cli.ts'] };
}

function runCli(arguments_: string[]): CliRun {
  const { command, prefixArgs } = resolveCliEntry();
  const result = spawnSync(command, [...prefixArgs, ...arguments_], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('CLI smoke', () => {
  it('prints --version', () => {
    const { status, stdout } = runCli(['--version']);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(packageVersion.version);
  });

  it('prints --help with subcommands', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('aitrack');
    expect(stdout).toContain('init');
    expect(stdout).toContain('show');
    expect(stdout).toContain('daemon');
    expect(stdout).toContain('top');
  });

  it('rejects invalid top kind', () => {
    const { status, stderr } = runCli(['top', 'weeks']);
    expect(status).toBe(1);
    expect(stderr).toContain('Invalid kind');
    expect(stderr).toContain('days');
    expect(stderr).toContain('models');
  });

  it('rejects invalid top --sort', () => {
    const { status, stderr } = runCli(['top', '--sort', 'price']);
    expect(status).toBe(1);
    expect(stderr).toContain('Invalid --sort value');
  });

  it('rejects invalid top --limit', () => {
    const { status, stderr } = runCli(['top', '--limit', '0']);
    expect(status).toBe(1);
    expect(stderr).toContain('Invalid --limit');
  });

  it('rejects invalid usage last days', () => {
    const { status, stderr } = runCli(['usage', 'last', '0']);
    expect(status).toBe(1);
    expect(stderr).toContain('Invalid number of days');
  });
});
