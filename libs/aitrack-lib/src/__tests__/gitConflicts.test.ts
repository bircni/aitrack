import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeMachineFile, makeProviderDay } from '@aitrack/test-fixtures';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'aitrack-git-conflicts-'));
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import type { MachineFile } from '../data/types.js';
import { checkRawMachineFile } from '../data/validate.js';
import {
  commitAndPush,
  commitDataChanges,
  LOCAL_REPO,
  pull,
  pushPendingCommits,
  replaceLocalClone,
} from '../git.js';
import { isRebaseInProgress } from '../git/exec.js';
import { encryptText, isEncryptedRaw } from '../store/encryption.js';

const ORIGIN = join(TEST_HOME, 'origin.git');
const OTHER = join(TEST_HOME, 'other');
const FILE = 'data/a.json';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function cloneInto(target: string): void {
  git(TEST_HOME, 'clone', ORIGIN, target);
  git(target, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(target, 'config', 'user.email', 'test@aitrack.test');
  git(target, 'config', 'user.name', 'Test');
}

/** Day-of-month to input tokens. */
function machineJson(days: Record<string, number>): string {
  const entries = Object.entries(days).map(
    ([day, tokens]) => [`2026-01-${day}`, { codex: makeProviderDay(tokens, 0) }] as const,
  );
  return JSON.stringify(makeMachineFile('a', Object.fromEntries(entries)), null, 2);
}

function largeMachineJson(tokens: number): string {
  const model = 'm'.repeat(1_500_000);
  const days = { '2026-01-01': { codex: makeProviderDay(tokens, 0, undefined, model) } };
  return JSON.stringify(makeMachineFile('a', days), null, 2);
}

function commitFile(repo: string, path: string, contents: string): void {
  mkdirSync(join(repo, 'data'), { recursive: true });
  writeFileSync(join(repo, path), contents);
  git(repo, 'add', '--', path);
  git(repo, 'commit', '-m', `sync: a changed ${path}`);
}

function commitOnRemote(path: string, contents: string): void {
  commitFile(OTHER, path, contents);
  git(OTHER, 'push', 'origin', 'HEAD:main');
}

function tokensByDay(raw: string): Record<string, number | undefined> {
  const { machine } = checkRawMachineFile(raw, FILE, { allowInconsistentCostTotals: true });
  if (!machine) throw new Error('expected a readable machine file');
  const days: MachineFile['days'] = machine.days;
  return Object.fromEntries(
    Object.entries(days).map(([date, day]) => [date.slice(-2), day.codex?.totals.inputTokens]),
  );
}

function resetRepos(): void {
  for (const path of [ORIGIN, OTHER, LOCAL_REPO]) rmSync(path, { recursive: true, force: true });
  mkdirSync(join(LOCAL_REPO, '..'), { recursive: true });
  git(TEST_HOME, 'init', '--bare', '--initial-branch=main', ORIGIN);
  cloneInto(OTHER);
}

function seedBothClones(): void {
  commitOnRemote(FILE, machineJson({ '01': 10 }));
  cloneInto(LOCAL_REPO);
}

describe('rebasing unpushed data commits with real git', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetRepos();
  });

  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('merges every conflicting unpushed commit on pull, so the next push succeeds', async () => {
    seedBothClones();
    commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20, '02': 5 }));
    commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20, '02': 6, '03': 7 }));
    commitOnRemote(FILE, machineJson({ '01': 15, '04': 9 }));

    await pull();

    expect(isRebaseInProgress()).toBe(false);
    expect(tokensByDay(readFileSync(join(LOCAL_REPO, FILE), 'utf8'))).toEqual({
      '01': 20,
      '02': 6,
      '03': 7,
      '04': 9,
    });
    expect(await pushPendingCommits()).toBe(true);
    git(LOCAL_REPO, 'fetch');
    expect(tokensByDay(git(LOCAL_REPO, 'show', `origin/main:${FILE}`))).toMatchObject({
      '02': 6,
      '04': 9,
    });
  });

  it('resolves every stop when a push is rejected with several commits waiting', async () => {
    seedBothClones();
    commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20 }));
    writeFileSync(join(LOCAL_REPO, FILE), machineJson({ '01': 20, '02': 5 }));
    commitOnRemote(FILE, machineJson({ '01': 15, '03': 9 }));

    expect(await commitAndPush('a')).toBe(true);

    expect(isRebaseInProgress()).toBe(false);
    git(LOCAL_REPO, 'fetch');
    expect(tokensByDay(git(LOCAL_REPO, 'show', `origin/main:${FILE}`))).toEqual({
      '01': 20,
      '02': 5,
      '03': 9,
    });
  });

  it('never merges away a commit that replaced days: it fails and stays unpushed', async () => {
    seedBothClones();
    commitOnRemote(FILE, machineJson({ '01': 100, '02': 201 }));
    writeFileSync(join(LOCAL_REPO, FILE), machineJson({ '01': 50 }));

    await expect(commitDataChanges('recompute: refresh costs', [FILE])).rejects.toThrow(
      'only sync commits merge per day',
    );
    await expect(pull()).rejects.toThrow('only sync commits merge per day');

    expect(isRebaseInProgress()).toBe(false);
    expect(tokensByDay(readFileSync(join(LOCAL_REPO, FILE), 'utf8'))).toEqual({ '01': 50 });
    git(LOCAL_REPO, 'fetch');
    expect(tokensByDay(git(LOCAL_REPO, 'show', `origin/main:${FILE}`))).toEqual({
      '01': 100,
      '02': 201,
    });
  });

  it('replays onto the named branch when the first push races another machine', async () => {
    cloneInto(LOCAL_REPO);
    mkdirSync(join(LOCAL_REPO, 'data'), { recursive: true });
    writeFileSync(join(LOCAL_REPO, FILE), machineJson({ '01': 1 }));
    commitOnRemote(FILE, machineJson({ '02': 2 }));

    expect(await commitAndPush('a')).toBe(true);

    git(LOCAL_REPO, 'fetch');
    expect(tokensByDay(git(LOCAL_REPO, 'show', `origin/main:${FILE}`))).toEqual({
      '01': 1,
      '02': 2,
    });
  });

  it('keeps a merged file encrypted when either side was', async () => {
    vi.stubEnv('AITRACK_ENCRYPTION_PASSPHRASE', 'secret');
    seedBothClones();
    commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20 }));
    commitOnRemote(FILE, encryptText(machineJson({ '01': 15, '02': 9 }), 'secret'));

    await pull();

    const merged = readFileSync(join(LOCAL_REPO, FILE), 'utf8');
    expect(isEncryptedRaw(merged)).toBe(true);
    expect(tokensByDay(merged)).toEqual({ '01': 20, '02': 9 });
  });

  it("merges a file larger than Node's default output buffer", async () => {
    seedBothClones();
    commitFile(LOCAL_REPO, FILE, largeMachineJson(20));
    commitOnRemote(FILE, largeMachineJson(15));

    await pull();

    expect(tokensByDay(readFileSync(join(LOCAL_REPO, FILE), 'utf8'))).toEqual({ '01': 20 });
  });

  it('recovers a rebase a dead process left behind', async () => {
    seedBothClones();
    commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20 }));
    commitOnRemote(FILE, machineJson({ '01': 15, '02': 9 }));
    expect(() => git(LOCAL_REPO, 'pull', '--rebase', '--quiet')).toThrow('Command failed');
    expect(isRebaseInProgress()).toBe(true);

    await pull();

    expect(isRebaseInProgress()).toBe(false);
    expect(git(LOCAL_REPO, 'branch', '--show-current')).toBe('main');
    expect(tokensByDay(readFileSync(join(LOCAL_REPO, FILE), 'utf8'))).toEqual({
      '01': 20,
      '02': 9,
    });
  });

  it.each([
    [
      'a file that is not a machine file',
      () => {
        commitFile(LOCAL_REPO, 'notes.txt', 'local');
        commitOnRemote('notes.txt', 'remote');
      },
    ],
    [
      'a machine file outside data/',
      () => {
        commitFile(LOCAL_REPO, 'a.json', machineJson({ '01': 20 }));
        commitOnRemote('a.json', machineJson({ '01': 15 }));
      },
    ],
    [
      'an unreadable remote side',
      () => {
        commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20 }));
        commitOnRemote(FILE, '{ not json');
      },
    ],
    [
      'a remote side from a newer schema',
      () => {
        commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20 }));
        commitOnRemote(
          FILE,
          JSON.stringify({ ...makeMachineFile('a'), schemaVersion: 999, future: true }, null, 2),
        );
      },
    ],
    [
      'an encrypted side this passphrase cannot open',
      () => {
        commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20 }));
        commitOnRemote(FILE, encryptText(machineJson({ '01': 15 }), 'someone else'));
      },
    ],
    [
      'a remote deletion',
      () => {
        commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20 }));
        git(OTHER, 'rm', '--', FILE);
        git(OTHER, 'commit', '-m', 'delete');
        git(OTHER, 'push', 'origin', 'HEAD:main');
      },
    ],
    [
      'one mergeable file beside one that is not',
      () => {
        commitFile(LOCAL_REPO, FILE, machineJson({ '01': 20 }));
        commitFile(LOCAL_REPO, 'notes.txt', 'local');
        commitOnRemote(FILE, machineJson({ '01': 15 }));
        commitOnRemote('notes.txt', 'remote');
      },
    ],
  ])('leaves the branch untouched on a conflict in %s', async (_label, arrange) => {
    seedBothClones();
    arrange();
    const head = git(LOCAL_REPO, 'rev-parse', 'HEAD');
    const before = readFileSync(join(LOCAL_REPO, FILE), 'utf8');

    await expect(pull()).rejects.toThrow('Could not merge the unpushed data commits');

    expect(isRebaseInProgress()).toBe(false);
    expect(git(LOCAL_REPO, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(LOCAL_REPO, FILE), 'utf8')).toBe(before);
    expect(git(LOCAL_REPO, 'status', '--porcelain')).toBe('');
  });

  it('keeps the old clone when the replacement clone fails, and swaps on success', () => {
    seedBothClones();
    commitFile(LOCAL_REPO, 'data/unpushed.json', machineJson({ '01': 1 }));

    expect(() => {
      replaceLocalClone(join(TEST_HOME, 'no-such-repo.git'));
    }).toThrow('git clone failed');
    expect(existsSync(join(LOCAL_REPO, 'data/unpushed.json'))).toBe(true);
    expect(existsSync(`${LOCAL_REPO}.incoming`)).toBe(false);

    replaceLocalClone(ORIGIN);
    expect(existsSync(join(LOCAL_REPO, 'data/unpushed.json'))).toBe(false);
    expect(existsSync(join(LOCAL_REPO, FILE))).toBe(true);
  });
});
