import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localTimestamp } from '../../__tests__/helpers/fixtures.js';

// vi.hoisted runs before module loading, so TEST_HOME is available in vi.mock factories below
const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-int-test`;
});

// Redirect homedir() so LOCAL_REPO and config paths land in our temp dir.
// vi.mock is hoisted before all imports, so git.ts picks up the mock when it
// evaluates `export const LOCAL_REPO = join(homedir(), ...)` at module load time.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// Keep execSync (used by git.ts) real; only silence exec() which opens the PNG viewer
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn() };
});

import { localMachineId, saveConfig } from '../../config.js';
import type { MachineFile } from '../../data/types.js';
import { commitAndPush, LOCAL_REPO } from '../../git.js';
import { showCommand } from '../show.js';
import { syncCommand } from '../sync.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function initOriginRepo(): string {
  const originDir = join(TEST_HOME, 'origin.git');
  mkdirSync(originDir, { recursive: true });
  execSync('git init --bare', { cwd: originDir, stdio: 'pipe' });
  return originDir;
}

function cloneToLocalRepo(originDir: string): void {
  mkdirSync(join(TEST_HOME, '.config', 'aitrack'), { recursive: true });
  execSync(`git clone "${originDir}" "${LOCAL_REPO}"`, { stdio: 'pipe' });
  // set identity so commits work even when global git config is absent (e.g. CI)
  execSync('git config user.email "test@aitrack.test"', { cwd: LOCAL_REPO, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: LOCAL_REPO, stdio: 'pipe' });
}

function writeClaudeData(lines: object[]): void {
  const projectDir = join(TEST_HOME, 'claude', 'projects', 'test-project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'history.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
}

function assistantLine(id: string, ts: string, inputTokens: number, outputTokens: number): object {
  return {
    type: 'assistant',
    timestamp: ts,
    requestId: `req-${id}`,
    message: {
      id,
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

function readMachineFile(filePath: string): MachineFile {
  return JSON.parse(readFileSync(filePath, 'utf8')) as MachineFile;
}

// ── tests ────────────────────────────────────────────────────────────────────

// Every case here drives real `git init`/`clone`/`push` through execSync, which
// costs seconds per test on Windows and more when workers run in parallel — the
// 15s default expires under load even though the slowest case takes ~4s alone.
describe('integration', { timeout: 60_000 }, () => {
  beforeEach(() => {
    mkdirSync(TEST_HOME, { recursive: true });
    process.env.XDG_CONFIG_HOME = TEST_HOME; // points claude reader at TEST_HOME/claude/projects
    delete process.env.CODEX_HOME; // prevent reading real codex data

    const originDir = initOriginRepo();
    cloneToLocalRepo(originDir);
    saveConfig({ repoUrl: originDir });
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('sync writes a machine JSON file and commits it to git', async () => {
    writeClaudeData([
      assistantLine('msg1', localTimestamp('2024-06-01'), 1000, 500),
      assistantLine('msg2', localTimestamp('2024-06-02'), 2000, 800),
    ]);

    await syncCommand();

    // Short hostname, not the FQDN: the machine identity must not change with
    // the network the machine happens to be on.
    const host = localMachineId();
    const dataFile = join(LOCAL_REPO, 'data', `${host}.json`);
    expect(host).not.toContain('.');
    expect(existsSync(dataFile)).toBe(true);

    const data = readMachineFile(dataFile);
    expect(data.hostname).toBe(host);
    expect(Object.keys(data.days)).toHaveLength(2);
    expect(data.days).toMatchObject({
      '2024-06-01': { claude_code: { totals: { inputTokens: 1000 } } },
      '2024-06-02': { claude_code: { totals: { inputTokens: 2000 } } },
    });

    // verify it was actually committed
    const log = execSync('git log --oneline', { cwd: LOCAL_REPO }).toString();
    expect(log).toContain(`sync: ${host}`);
  });

  it('sync is idempotent: second sync with identical data does not create a new commit', async () => {
    writeClaudeData([assistantLine('msg1', localTimestamp('2024-06-01'), 1000, 500)]);

    await syncCommand();
    const commitsAfterFirst = execSync('git log --oneline', { cwd: LOCAL_REPO })
      .toString()
      .trim()
      .split('\n').length;

    await syncCommand();
    const commitsAfterSecond = execSync('git log --oneline', { cwd: LOCAL_REPO })
      .toString()
      .trim()
      .split('\n').length;

    expect(commitsAfterSecond).toBe(commitsAfterFirst);
  });

  it('rebases and preserves both machines when concurrent pushes race', () => {
    const originDir = join(TEST_HOME, 'origin.git');
    const dataDir = join(LOCAL_REPO, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'machine-a.json'),
      JSON.stringify({ hostname: 'machine-a', lastUpdated: 'first', days: {} }),
    );
    expect(commitAndPush('machine-a')).toBe(true);

    const secondClone = join(TEST_HOME, 'machine-b-repo');
    execSync(`git clone "${originDir}" "${secondClone}"`, { stdio: 'pipe' });
    execSync('git config user.email "machine-b@aitrack.test"', {
      cwd: secondClone,
      stdio: 'pipe',
    });
    execSync('git config user.name "Machine B"', { cwd: secondClone, stdio: 'pipe' });
    mkdirSync(join(secondClone, 'data'), { recursive: true });
    writeFileSync(
      join(secondClone, 'data', 'machine-b.json'),
      JSON.stringify({ hostname: 'machine-b', lastUpdated: 'concurrent', days: {} }),
    );
    writeFileSync(
      join(secondClone, 'data', 'machine-a.json'),
      JSON.stringify({ hostname: 'machine-a', lastUpdated: 'remote-race', days: {} }),
    );
    execSync('git add data/ && git commit -m "sync: machine-b"', {
      cwd: secondClone,
      stdio: 'pipe',
    });

    writeFileSync(
      join(dataDir, 'machine-a.json'),
      JSON.stringify({ hostname: 'machine-a', lastUpdated: 'local-wins', days: {} }),
    );
    execSync('git push', { cwd: secondClone, stdio: 'pipe' });

    expect(commitAndPush('machine-a')).toBe(true);

    const machineA = JSON.parse(
      execSync('git show HEAD:data/machine-a.json', { cwd: LOCAL_REPO }).toString(),
    ) as MachineFile;
    const machineB = JSON.parse(
      execSync('git show HEAD:data/machine-b.json', { cwd: LOCAL_REPO }).toString(),
    ) as MachineFile;
    expect(machineA.lastUpdated).toBe('local-wins');
    expect(machineB.lastUpdated).toBe('concurrent');
    expect(execSync('git rev-list --count HEAD', { cwd: LOCAL_REPO }).toString().trim()).toBe('3');
  });

  it('sync with no AI data exits cleanly without committing anything', async () => {
    // no JSONL files → readClaudeData/readCodexData return empty Maps → early return
    await expect(syncCommand()).resolves.toBeUndefined();

    const dataDir = join(LOCAL_REPO, 'data');
    expect(existsSync(dataDir)).toBe(false);
  });

  it('show renders a PNG from synced data', async () => {
    writeClaudeData([
      assistantLine('msg1', localTimestamp('2024-06-01'), 1000, 500),
      assistantLine('msg2', localTimestamp('2024-06-15'), 500, 200),
    ]);

    await syncCommand();

    const outputPath = join(TEST_HOME, 'output.png');
    await showCommand({ output: outputPath, providers: ['claude_code', 'codex'] });

    expect(existsSync(outputPath)).toBe(true);
    const buffer = readFileSync(outputPath);
    // PNG magic bytes: 89 50 4E 47
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  });

  it('show merges data from multiple machines into a single heatmap', async () => {
    // Simulate a second machine's JSON already in the repo
    const dataDir = join(LOCAL_REPO, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'other-machine.json'),
      JSON.stringify({
        hostname: 'other-machine',
        lastUpdated: new Date().toISOString(),
        days: {
          '2024-06-10': {
            claude_code: {
              byModel: { 'claude-3-opus': { inputTokens: 3000, outputTokens: 1000 } },
              totals: { inputTokens: 3000, outputTokens: 1000 },
            },
          },
        },
      }),
    );
    execSync('git add data/', { cwd: LOCAL_REPO, stdio: 'pipe' });
    execSync('git commit -m "other machine data"', { cwd: LOCAL_REPO, stdio: 'pipe' });
    execSync('git push', { cwd: LOCAL_REPO, stdio: 'pipe' });

    // Also sync this machine's data
    writeClaudeData([assistantLine('msg1', localTimestamp('2024-06-01'), 1000, 500)]);
    await syncCommand();

    const outputPath = join(TEST_HOME, 'merged.png');
    await showCommand({ output: outputPath, providers: ['claude_code', 'codex'] });

    expect(existsSync(outputPath)).toBe(true);
    const buffer = readFileSync(outputPath);
    expect(buffer[0]).toBe(0x89); // valid PNG
  });
});
