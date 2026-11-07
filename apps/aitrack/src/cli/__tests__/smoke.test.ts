import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '../../..');
const packageVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
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
    const entry = join(packageRoot, smokeCli);
    if (!existsSync(entry)) {
      throw new Error(`SMOKE_CLI not found: ${entry}`);
    }
    return { command: process.execPath, prefixArgs: [entry] };
  }
  // Spawn node itself rather than a package-manager shim: on Windows those are
  // `.cmd` files, which spawnSync refuses to run without a shell (ENOENT).
  return { command: process.execPath, prefixArgs: ['--import', 'tsx', 'src/cli.ts'] };
}

const home = mkdtempSync(join(tmpdir(), 'aitrack-smoke-'));

function runCli(
  arguments_: string[],
  {
    nodeArgs = [],
    env = { FORCE_COLOR: '0' },
  }: { nodeArgs?: string[]; env?: NodeJS.ProcessEnv } = {},
): CliRun {
  const { command, prefixArgs } = resolveCliEntry();
  const { FORCE_COLOR: _inherited, NO_COLOR: _alsoInherited, ...inherited } = process.env;
  const result = spawnSync(command, [...nodeArgs, ...prefixArgs, ...arguments_], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...inherited,
      ...env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      APPDATA: home,
    },
  });
  // Without this a failed spawn surfaces as `status: null`, which every
  // assertion below reports as "expected null to be 0".
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('CLI smoke', () => {
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // Sources have no scanWorker.js beside them, and a worker that fails falls back without a sign.
  it.runIf(process.env.SMOKE_CLI)('scans on a worker thread from the built library', () => {
    const transcript = join(home, 'scan.jsonl');
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-15T12:00:00Z',
        requestId: 'r',
        message: { id: 'm', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
      })}\n`,
    );
    const script = `
      import { ScanPool, scanWorkerEntry } from 'aitrack-lib/readers/scanPool';
      const pool = new ScanPool(scanWorkerEntry(), 2);
      const messages = await pool.scan('claude', process.argv[1]);
      console.log(JSON.stringify({ messages: messages.length, workers: pool.running.size, broken: pool.isBroken }));
      await pool.close();
    `;
    const result = spawnSync(process.execPath, ['-e', script, transcript], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ messages: 1, workers: 2, broken: false });
  });

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
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('top');
  });

  it('rejects an invalid argument', () => {
    const { status, stderr } = runCli(['top', 'weeks']);
    expect(status).toBe(2);
    expect(stderr).toContain('Allowed choices are days, models');
  });

  it('keeps a --json parser failure machine-readable', () => {
    const { status, stdout } = runCli(['top', 'weeks', '--json']);
    expect(status).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ command: 'top' });
  });

  it('says what init needs without a terminal, instead of exit 0 with nothing written', () => {
    const { status, stderr } = runCli(['init']);
    expect(status).toBe(2);
    expect(stderr).toContain('--repo');
  });

  it('honours NO_COLOR on a terminal', () => {
    // Chalk asks tty.isatty; a pipe would hide the difference.
    const nodeArgs = [
      '--import',
      "data:text/javascript,import tty from 'node:tty'; tty.isatty = () => true;",
    ];
    expect(runCli(['config', 'set', 'compactAfterDays', '30']).status).toBe(0);
    expect(runCli(['config', 'list'], { nodeArgs, env: {} }).stdout).toContain('\u001B[');
    expect(runCli(['config', 'list'], { nodeArgs, env: { NO_COLOR: '1' } }).stdout).not.toContain(
      '\u001B[',
    );
  });

  it('refuses --watch without a terminal', () => {
    const { status, stderr } = runCli(['usage', 'today', '--watch']);
    expect(status).toBe(2);
    expect(stderr).toContain('interactive terminal');
  });
});
