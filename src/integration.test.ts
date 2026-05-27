import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { execSync } from 'node:child_process';

// vi.hoisted runs before module loading, so TEST_HOME is available in vi.mock factories below
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${tmp}/aitrack-int-test`;
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

import { syncCommand } from './sync.js';
import { showCommand } from './show.js';
import { saveConfig } from './config.js';
import { LOCAL_REPO } from './git.js';
import type { MachineFile } from './types.js';

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

describe('integration', () => {
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
      assistantLine('msg1', '2024-06-01T12:00:00Z', 1000, 500),
      assistantLine('msg2', '2024-06-02T12:00:00Z', 2000, 800),
    ]);

    await syncCommand();

    const host = hostname();
    const dataFile = join(LOCAL_REPO, 'data', `${host}.json`);
    expect(existsSync(dataFile)).toBe(true);

    const data = readMachineFile(dataFile);
    expect(data.hostname).toBe(host);
    expect(Object.keys(data.days).length).toBe(2);
    expect(data.days['2024-06-01'].claude_code.totals.inputTokens).toBe(1000);
    expect(data.days['2024-06-02'].claude_code.totals.inputTokens).toBe(2000);

    // verify it was actually committed
    const log = execSync('git log --oneline', { cwd: LOCAL_REPO }).toString();
    expect(log).toContain(`sync: ${host}`);
  });

  it('sync is idempotent: second sync with identical data does not create a new commit', async () => {
    writeClaudeData([assistantLine('msg1', '2024-06-01T12:00:00Z', 1000, 500)]);

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

  it('sync with no AI data exits cleanly without committing anything', async () => {
    // no JSONL files → readClaudeData/readCodexData return empty Maps → early return
    await expect(syncCommand()).resolves.toBeUndefined();

    const dataDir = join(LOCAL_REPO, 'data');
    expect(existsSync(dataDir)).toBe(false);
  });

  it('show renders a PNG from synced data', async () => {
    writeClaudeData([
      assistantLine('msg1', '2024-06-01T12:00:00Z', 1000, 500),
      assistantLine('msg2', '2024-06-15T12:00:00Z', 500, 200),
    ]);

    await syncCommand();

    const outputPath = join(TEST_HOME, 'output.png');
    await showCommand({ output: outputPath, noCursor: true });

    expect(existsSync(outputPath)).toBe(true);
    const buf = readFileSync(outputPath);
    // PNG magic bytes: 89 50 4E 47
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
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
    writeClaudeData([assistantLine('msg1', '2024-06-01T12:00:00Z', 1000, 500)]);
    await syncCommand();

    const outputPath = join(TEST_HOME, 'merged.png');
    await showCommand({ output: outputPath, noCursor: true });

    expect(existsSync(outputPath)).toBe(true);
    const buf = readFileSync(outputPath);
    expect(buf[0]).toBe(0x89); // valid PNG
  });
});
