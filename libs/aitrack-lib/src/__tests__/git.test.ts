import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFile: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('child_process', () => ({ spawnSync: mocks.spawnSync, execFile: mocks.execFile }));

/** Queue results for the async git calls (the network ones), in call order. */
function asyncGitReplies(...replies: Array<{ status: number; stdout?: string; stderr?: string }>) {
  for (const { status, stdout = '', stderr = '' } of replies) {
    mocks.execFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (...r: unknown[]) => void,
      ) => {
        const error = status === 0 ? null : Object.assign(new Error('failed'), { code: status });
        queueMicrotask(() => {
          callback(error, stdout, stderr); // execFile never calls back synchronously.
        });
      },
    );
  }
}

vi.mock('fs', () => ({
  constants: { COPYFILE_EXCL: 1 },
  existsSync: mocks.existsSync,
  readdirSync: mocks.readdirSync,
  readFileSync: mocks.readFileSync,
  mkdirSync: mocks.mkdirSync,
  writeFileSync: mocks.writeFileSync,
  copyFileSync: mocks.copyFileSync,
  rmSync: mocks.rmSync,
}));
vi.mock('os', () => ({ homedir: () => '/home/test' }));

import {
  adoptPendingDataFiles,
  cloneOriginUrl,
  cloneRepo,
  commitAndPush,
  commitDataChanges,
  hasMachineDataChanges,
  hasUnpushedCommits,
  isCloned,
  listDataFiles,
  listPendingDataFiles,
  migrateMachineDataFiles,
  pull,
  pushPendingCommits,
  readDataFile,
  removeLocalClone,
  removePendingMachineFile,
  writeMachineFile,
  writePendingMachineFile,
} from '../git.js';
import { isRebaseInProgress, pushWithRetry, runGit, runGitAsync } from '../git/exec.js';
import { withRepoLock } from '../git/lock.js';

describe('git helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawnSync.mockReset().mockReturnValue({ status: 0 });
    mocks.execFile.mockReset();
  });

  it('detects, clones, and removes the local data repository', () => {
    mocks.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mocks.spawnSync.mockReturnValue({ status: 0 });

    expect(isCloned()).toBe(true);
    cloneRepo('git@example.com:me/data.git');
    removeLocalClone();

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        '--',
        'git@example.com:me/data.git',
        expect.stringContaining(join('aitrack', 'repo')),
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    expect(mocks.rmSync).toHaveBeenCalledWith(expect.stringContaining(join('aitrack', 'repo')), {
      recursive: true,
      force: true,
    });

    mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: 'git@example.com:me/data.git\n' });
    expect(cloneOriginUrl()).toBe('git@example.com:me/data.git');
    expect(mocks.spawnSync).toHaveBeenLastCalledWith(
      'git',
      ['config', '--get', 'remote.origin.url'],
      expect.anything(),
    );
    mocks.spawnSync.mockReturnValueOnce({ status: 2, stderr: 'no such remote' });
    expect(cloneOriginUrl()).toBeNull();
  });

  it('surfaces clone failures', () => {
    mocks.spawnSync.mockReturnValue({ status: 1 });

    expect(() => {
      cloneRepo('git@example.com:me/data.git');
    }).toThrow('git clone failed with exit code 1');
  });

  it('tolerates a failed pull when the remote has no heads', async () => {
    asyncGitReplies({ status: 1, stderr: "couldn't find remote ref" }, { status: 0, stdout: '' });

    await pull();

    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    expect(mocks.execFile).toHaveBeenLastCalledWith(
      'git',
      ['ls-remote', '--heads', 'origin'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('pulls fast-forward-only in one round trip', async () => {
    asyncGitReplies({ status: 0 });

    await pull({ timeoutMs: 1000 });

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenLastCalledWith(
      'git',
      ['pull', '--ff-only', '--quiet'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('gives up on a git that never answers', async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn();
      mocks.execFile.mockReturnValue({ pid: undefined, kill });
      await Promise.all([
        expect(pull({ timeoutMs: 1000 })).rejects.toThrow('git pull --ff-only --quiet timed out'),
        vi.advanceTimersByTimeAsync(1000),
      ]);
      expect(kill).toHaveBeenCalled();
      expect(mocks.execFile).toHaveBeenCalledTimes(1);
      const options = mocks.execFile.mock.calls[0]?.[2] as { env?: Record<string, string> };
      expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports commits the upstream does not have yet', async () => {
    asyncGitReplies(
      // hasUpstream
      { status: 0, stdout: 'origin/main' },
      // rev-list --count @{upstream}..HEAD
      { status: 0, stdout: '1\n' },
    );

    expect(await hasUnpushedCommits()).toBe(true);
    expect(mocks.execFile).toHaveBeenLastCalledWith(
      'git',
      ['rev-list', '--count', '@{upstream}..HEAD'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('reports nothing unpushed when the branch matches its upstream', async () => {
    asyncGitReplies({ status: 0, stdout: 'origin/main' }, { status: 0, stdout: '0\n' });

    expect(await hasUnpushedCommits()).toBe(false);
  });

  it('reports nothing unpushed when the branch has no upstream', async () => {
    asyncGitReplies({ status: 1 });

    expect(await hasUnpushedCommits()).toBe(false);
  });

  it('treats a failing rev-list as nothing to retry rather than throwing', async () => {
    asyncGitReplies(
      // hasUpstream succeeds...
      { status: 0, stdout: 'origin/main' },
      // ...but rev-list blows up (e.g. a fresh repo with no commits yet)
      { status: 128, stderr: 'fatal: bad revision' },
    );

    expect(await hasUnpushedCommits()).toBe(false);
  });

  it('pushes commits stranded by an earlier failed push, asking for the upstream once', async () => {
    asyncGitReplies(
      // hasUpstream, rev-list, push
      { status: 0, stdout: 'origin/main' },
      { status: 0, stdout: '2\n' },
      { status: 0 },
    );

    expect(await pushPendingCommits()).toBe(true);
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
    expect(mocks.execFile).toHaveBeenLastCalledWith(
      'git',
      ['push'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('does not push when the branch is already in sync', async () => {
    asyncGitReplies({ status: 0, stdout: 'origin/main' }, { status: 0, stdout: '0\n' });

    expect(await pushPendingCommits()).toBe(false);
  });

  it('runs overlapping repo operations one after the other', async () => {
    const order: string[] = [];
    const first = withRepoLock(async () => {
      order.push('first start');
      await Promise.resolve();
      order.push('first end');
    });
    const second = withRepoLock(async () => {
      order.push('second start');
      await withRepoLock(() => Promise.resolve(order.push('nested')));
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second start', 'nested']);
  });

  it('rebases instead of failing when a stranded commit diverged the branch', async () => {
    asyncGitReplies(
      // pull --ff-only rejects the diverged branch
      { status: 1, stderr: 'Not possible to fast-forward' },
      // ls-remote
      { status: 0, stdout: 'refs/heads/main' },
      // hasUnpushedCommits: hasUpstream, then rev-list
      { status: 0, stdout: 'origin/main' },
      { status: 0, stdout: '1\n' },
      // pull --rebase
      { status: 0 },
    );

    await pull();

    expect(mocks.execFile).toHaveBeenLastCalledWith(
      'git',
      ['pull', '--rebase', '--quiet'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('aborts a conflicted rebase so the repo is not left mid-rebase', async () => {
    // A failed `pull --rebase` can stop with conflicts applied and the branch
    // detached. Leaving that behind makes every later aitrack command fail with
    // a confusing git error the user never asked for.
    asyncGitReplies(
      // pull --ff-only rejects the diverged branch
      { status: 1, stderr: 'Not possible to fast-forward' },
      // ls-remote
      { status: 0, stdout: 'refs/heads/main' },
      // hasUnpushedCommits: hasUpstream, then rev-list
      { status: 0, stdout: 'origin/main' },
      { status: 0, stdout: '1\n' },
      // pull --rebase hits a conflict
      { status: 1, stderr: 'could not apply' },
      // rebase --abort
      { status: 0 },
    );
    // isRebaseInProgress reads .git/rebase-merge from disk, not git.
    mocks.existsSync.mockImplementation((path: string) => path.includes('rebase-'));

    await expect(pull()).rejects.toThrow('git pull --rebase --quiet failed');

    expect(mocks.execFile).toHaveBeenLastCalledWith(
      'git',
      ['rebase', '--abort'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('still reports the rebase failure when the abort itself fails', async () => {
    // Nothing can be done about a failed abort, but the original rebase error
    // is what explains the situation, so it must not be replaced.
    asyncGitReplies(
      { status: 1, stderr: 'Not possible to fast-forward' },
      { status: 0, stdout: 'refs/heads/main' },
      { status: 0, stdout: 'origin/main' },
      { status: 0, stdout: '1\n' },
      { status: 1, stderr: 'could not apply' },
      // rebase --abort fails too
      { status: 1, stderr: 'abort failed' },
    );
    mocks.existsSync.mockImplementation((path: string) => path.includes('rebase-'));

    await expect(pull()).rejects.toThrow('git pull --rebase --quiet failed');
  });

  it('surfaces a fast-forward failure that no local commit explains', async () => {
    asyncGitReplies(
      { status: 1, stderr: 'some other failure' },
      { status: 0, stdout: 'refs/heads/main' },
      // hasUnpushedCommits: no upstream
      { status: 1 },
    );

    await expect(pull()).rejects.toThrow(
      'git pull --ff-only --quiet failed with exit code 1: some other failure',
    );
  });

  it('returns false when there are no staged data changes', async () => {
    asyncGitReplies({ status: 0 }, { status: 0, stdout: '' });

    expect(await commitAndPush('host')).toBe(false);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual(['add', '--', ':(literal)data/host.json']);
    expect(mocks.execFile.mock.calls[1]?.[1]).toEqual([
      'diff',
      '--cached',
      '--name-only',
      '--',
      'data/',
    ]);
  });

  it('stages the whole data dir and reports when nothing was committed', async () => {
    asyncGitReplies(
      // add data/
      { status: 0 },
      // diff --cached: nothing staged
      { status: 0, stdout: '' },
    );

    expect(await commitDataChanges('recompute costs')).toBe(false);
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual(['add', 'data/']);
  });

  it('commits every staged data file when recomputing costs across machines', async () => {
    asyncGitReplies(
      // add data/
      { status: 0 },
      // diff --cached: two machines changed
      { status: 0, stdout: 'data/host.json\ndata/laptop.json\n' },
      // commit
      { status: 0 },
      // pushWithRetry: hasUpstream, then push
      { status: 0, stdout: 'origin/main' },
      { status: 0 },
    );

    expect(await commitDataChanges('recompute costs')).toBe(true);
    expect(mocks.execFile.mock.calls[2]?.[1]).toEqual(['commit', '-m', 'recompute costs']);
  });

  it('commits a staged deletion instead of failing to read the file back', async () => {
    // The user cleared their history by deleting the machine file. Reading it
    // back unconditionally aborted the sync with a raw ENOENT.
    mocks.existsSync.mockReturnValue(false);
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    asyncGitReplies(
      // add
      { status: 0 },
      // diff --cached
      { status: 0, stdout: 'D  data/host.json\n' },
      // commit
      { status: 0 },
      // pushWithRetry: hasUpstream, then push
      { status: 0, stdout: 'origin/main' },
      { status: 0 },
    );

    expect(await commitAndPush('host')).toBe(true);
    expect(mocks.readFileSync).not.toHaveBeenCalled();

    // These two are not reset in beforeEach, and a throwing readFileSync would
    // leak into every test after this one.
    mocks.existsSync.mockReset();
    mocks.readFileSync.mockReset();
  });

  it('surfaces commit failures when there are staged data changes', async () => {
    asyncGitReplies({ status: 0 }, { status: 0, stdout: 'A  data/host.json\n' }, { status: 1 });
    await expect(commitAndPush('host')).rejects.toThrow('git commit -m sync: host');
  });

  it('sets upstream only when the branch has none', async () => {
    asyncGitReplies(
      // add, diff --cached, commit
      { status: 0 },
      { status: 0, stdout: 'A  data/host.json\n' },
      { status: 0 },
      // hasUpstream: none, then branch --show-current, then push
      { status: 1 },
      { status: 0, stdout: 'main\n' },
      { status: 0 },
    );

    expect(await commitAndPush('host')).toBe(true);
    expect(mocks.execFile).toHaveBeenLastCalledWith(
      'git',
      ['push', '-u', 'origin', 'HEAD'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('does not disguise a genuine push failure as a missing upstream', async () => {
    asyncGitReplies(
      { status: 0 },
      { status: 0, stdout: 'data/host.json\n' },
      { status: 0 },
      { status: 0, stdout: 'origin/main\n' },
      { status: 1, stderr: 'remote: permission denied' },
    );

    await expect(commitAndPush('host')).rejects.toThrow('permission denied');
    expect(
      mocks.execFile.mock.calls.some((call) => Array.isArray(call[1]) && call[1].includes('-u')),
    ).toBe(false);
  });

  it('rebases and retries a non-fast-forward push', async () => {
    asyncGitReplies(
      { status: 0 },
      { status: 0, stdout: 'data/host.json\n' },
      { status: 0 },
      { status: 0, stdout: 'origin/main\n' },
      { status: 1, stderr: ' ! [rejected] main -> main (fetch first)' },
      // pull --rebase, then the retried push
      { status: 0 },
      { status: 0 },
    );

    expect(await commitAndPush('host')).toBe(true);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['pull', '--rebase', '--quiet'],
      expect.anything(),
      expect.any(Function),
    );
    expect(
      mocks.execFile.mock.calls.filter((call) => Array.isArray(call[1]) && call[1][0] === 'push'),
    ).toHaveLength(2);
  });

  it('checks literal git status only for a bracketed machine target', async () => {
    asyncGitReplies({ status: 0, stdout: '?? data/new-host[1].json\n' });

    expect(await hasMachineDataChanges('new-host[1]')).toBe(true);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain', '--', ':(literal)data/new-host[1].json'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('returns no data files when the data directory is missing', () => {
    mocks.existsSync.mockReturnValue(false);

    expect(listDataFiles()).toEqual([]);
  });

  it('lists only json data files and reads machine data', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['host.json', 'notes.txt']);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        schemaVersion: 2,
        hostname: 'host',
        timezone: 'UTC',
        dayBucket: 'utc',
        lastUpdated: 'now',
        days: {},
      }),
    );

    const files = listDataFiles();

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('host.json');
    const file = files[0];
    expect(file).toBeDefined();
    if (file === undefined) throw new Error('expected one data file');
    expect(readDataFile(file)).toEqual({
      schemaVersion: 2,
      hostname: 'host',
      timezone: 'UTC',
      dayBucket: 'utc',
      lastUpdated: 'now',
      days: {},
    });
  });

  it('writes a machine file through the store, creating the parent directory', () => {
    writeMachineFile('/repo/data/host.json', {
      schemaVersion: 2,
      hostname: 'host',
      timezone: 'UTC',
      dayBucket: 'utc',
      lastUpdated: 'now',
      days: {},
    });

    expect(mocks.mkdirSync).toHaveBeenCalledWith('/repo/data', { recursive: true });
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      '/repo/data/host.json',
      expect.stringContaining('"hostname": "host"'),
      'utf8',
    );
  });

  it('writes and lists pending machine files for a legitimate custom id', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['Work Laptop_01.2.json']);

    writePendingMachineFile({
      schemaVersion: 2,
      hostname: 'Work Laptop_01.2',
      timezone: 'UTC',
      dayBucket: 'utc',
      lastUpdated: 'now',
      days: {},
    });

    expect(mocks.mkdirSync).toHaveBeenCalled();
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(join('pending', 'data', 'Work Laptop_01.2.json')),
      expect.any(String),
      'utf8',
    );
    expect(listPendingDataFiles()).toHaveLength(1);
  });

  it.each(['../escape', '..\\escape', 'nested/machine'])(
    'rejects unsafe pending machine id %j before touching the filesystem',
    (hostname) => {
      expect(() => {
        writePendingMachineFile({
          schemaVersion: 2,
          hostname,
          timezone: 'UTC',
          dayBucket: 'utc',
          lastUpdated: 'now',
          days: {},
        });
      }).toThrow('Machine name');
      expect(mocks.mkdirSync).not.toHaveBeenCalled();
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
    },
  );

  it('migrates persisted and pending files and updates their hostname', () => {
    mocks.existsSync.mockImplementation((path: string) => path.endsWith(join('data', 'old.json')));
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ hostname: 'old', lastUpdated: 'now', days: {} }),
    );

    migrateMachineDataFiles('old', 'Work Laptop_01.2');

    expect(mocks.writeFileSync).toHaveBeenCalledTimes(2);
    for (const [target, contents, options] of mocks.writeFileSync.mock.calls) {
      expect(String(target)).toContain('Work Laptop_01.2.json');
      expect(JSON.parse(String(contents))).toMatchObject({
        hostname: 'Work Laptop_01.2',
        lastUpdated: 'now',
      });
      expect(options).toEqual({ encoding: 'utf8', flag: 'wx' });
    }
    expect(mocks.rmSync).toHaveBeenCalledWith(expect.stringContaining('old.json'));
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'git',
      ['add', '--', ':(literal)data/old.json', ':(literal)data/Work Laptop_01.2.json'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('migrates a structurally valid file with stale aggregate cost totals', () => {
    mocks.existsSync.mockImplementation((path: string) =>
      path.endsWith(join('data', 'old-cost.json')),
    );
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        hostname: 'old-cost',
        lastUpdated: 'now',
        days: {
          '2026-01-01': {
            codex: {
              byModel: { gpt: { inputTokens: 10, outputTokens: 5, costUSD: 1 } },
              totals: { inputTokens: 10, outputTokens: 5, costUSD: 99 },
            },
          },
        },
      }),
    );

    migrateMachineDataFiles('old-cost', 'new-cost');

    const migrated = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])) as {
      hostname: string;
      days: Record<string, { codex: { totals: { costUSD: number } } }>;
    };
    expect(migrated.hostname).toBe('new-cost');
    expect(migrated.days['2026-01-01']?.codex.totals.costUSD).toBe(99);
  });

  it('rejects a machine migration when the destination already exists', () => {
    mocks.existsSync.mockImplementation(
      (path: string) => path.endsWith(join('data', 'old.json')) || path.endsWith('new.json'),
    );

    expect(() => {
      migrateMachineDataFiles('old', 'new');
    }).toThrow('already exists');
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('adopts pending files into the repo data directory', () => {
    mocks.existsSync.mockImplementation((path: string) => path.includes(join('pending', 'data')));
    mocks.readdirSync.mockReturnValue(['host.json', 'other.json']);

    const adopted = adoptPendingDataFiles('/home/test/.config/aitrack/repo/data');

    expect(adopted).toBe(2);
    expect(mocks.copyFileSync).toHaveBeenCalledTimes(2);
    expect(mocks.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('host.json'),
      expect.stringContaining(join('repo', 'data', 'host.json')),
      1,
    );
    expect(mocks.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(join('pending', 'data')),
      expect.objectContaining({ recursive: true }),
    );
  });

  it('skips an already-synced file while adopting pending data instead of aborting', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['host.json']);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Aborting here used to brick init: it is the only command that writes the
    // config back, so a stale staged file made every retry fail.
    expect(adoptPendingDataFiles('/home/test/.config/aitrack/repo/data')).toBe(0);
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('host.json'));
    // The files are kept, so the warning has to say where they are.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(join('pending', 'data')));
  });

  it('skips an unsafe pending filename instead of aborting adoption', () => {
    mocks.existsSync.mockImplementation((path: string) => path.includes(join('pending', 'data')));
    mocks.readdirSync.mockReturnValue(['..\\escape.json', 'host.json']);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(adoptPendingDataFiles('/home/test/.config/aitrack/repo/data')).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('..\\escape.json'));
    expect(mocks.copyFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('host.json'),
      expect.stringContaining(join('repo', 'data', 'host.json')),
      1,
    );
  });

  it('skips a pending file whose name only differs after normalization', () => {
    // ` host.json` validates but trims to `host`, so adopting it would silently
    // rename the machine's data. Skip it so a stray file cannot brick init.
    mocks.existsSync.mockImplementation((path: string) => path.includes(join('pending', 'data')));
    mocks.readdirSync.mockReturnValue([' host.json', 'host.json']);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(adoptPendingDataFiles('/home/test/.config/aitrack/repo/data')).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(' host.json'));
    expect(mocks.copyFileSync).toHaveBeenCalledTimes(1);
  });

  it('rolls back the copied file when deleting the staged source fails', () => {
    mocks.existsSync.mockImplementation((path: string) => path.includes(join('pending', 'data')));
    mocks.readdirSync.mockReturnValue(['host.json']);
    // The copy lands, then removing the staged source throws — the half-done
    // adoption has to undo its own copy before propagating the error.
    mocks.rmSync.mockImplementationOnce(() => {
      throw new Error('EBUSY: staged file is locked');
    });

    expect(() => adoptPendingDataFiles('/home/test/.config/aitrack/repo/data')).toThrow('EBUSY');
    expect(mocks.copyFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(join('repo', 'data', 'host.json')),
      expect.objectContaining({ force: true }),
    );
  });

  it('removes a pending file for a machine id', () => {
    mocks.existsSync.mockReturnValue(true);

    removePendingMachineFile('host');

    expect(mocks.rmSync).toHaveBeenCalledWith(expect.stringContaining('host.json'));
  });

  it('does not remove a missing pending file', () => {
    mocks.existsSync.mockReturnValue(false);

    removePendingMachineFile('host');

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('refuses to migrate a source file that is not a valid machine file', () => {
    // Renaming rewrites the hostname inside the file, so a file that cannot be
    // parsed cannot be rewritten either. Better to stop than to move a file the
    // rest of the tool will then skip.
    mocks.existsSync.mockImplementation((path: string) => path.endsWith(join('data', 'old.json')));
    mocks.readFileSync.mockReturnValue('{not json');

    expect(() => {
      migrateMachineDataFiles('old', 'new');
    }).toThrow('is invalid');
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('reports both failures when the rollback itself fails', () => {
    // The worst case: the migration failed AND the restore failed. Losing the
    // rollback error here would leave the user with a half-migrated data
    // directory and only the original error to explain it.
    const repoOld = join('/home/test', '.config', 'aitrack', 'repo', 'data', 'old.json');
    const pendingNew = join('/home/test', '.config', 'aitrack', 'pending', 'data', 'new.json');
    const original = JSON.stringify({ hostname: 'old', lastUpdated: 'now', days: {} });
    const files = new Map<string, string>([
      [repoOld, original],
      [join('/home/test', '.config', 'aitrack', 'pending', 'data', 'old.json'), original],
    ]);

    mocks.existsSync.mockImplementation((path: string) => files.has(path));
    mocks.readFileSync.mockImplementation((path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`missing ${path}`);
      return contents;
    });
    mocks.writeFileSync.mockImplementation((path: string, contents: string) => {
      if (path === pendingNew) throw new Error('pending write failed');
      // The restore of the repo source is what fails during rollback.
      if (path === repoOld) throw new Error('restore failed');
      files.set(path, contents);
    });
    mocks.rmSync.mockImplementation((path: string) => {
      files.delete(path);
    });

    let thrown: unknown;
    try {
      migrateMachineDataFiles('old', 'new');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toContain('rollback failed');
    expect((aggregate.errors[0] as Error).message).toBe('pending write failed');
    expect((aggregate.errors[1] as Error).message).toBe('restore failed');
  });

  it('does not leave a restored source behind when removing the target fails', () => {
    // rollbackMachineFileMigration writes the source back before removing the
    // target. If that removal fails, both files would exist and the next sync
    // would see two machines; the restored source has to come back off disk.
    const repoOld = join('/home/test', '.config', 'aitrack', 'repo', 'data', 'old.json');
    const repoNew = join('/home/test', '.config', 'aitrack', 'repo', 'data', 'new.json');
    const pendingNew = join('/home/test', '.config', 'aitrack', 'pending', 'data', 'new.json');
    const original = JSON.stringify({ hostname: 'old', lastUpdated: 'now', days: {} });
    const files = new Map<string, string>([
      [repoOld, original],
      [join('/home/test', '.config', 'aitrack', 'pending', 'data', 'old.json'), original],
    ]);

    mocks.existsSync.mockImplementation((path: string) => files.has(path));
    mocks.readFileSync.mockImplementation((path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`missing ${path}`);
      return contents;
    });
    mocks.writeFileSync.mockImplementation((path: string, contents: string) => {
      if (path === pendingNew) throw new Error('pending write failed');
      files.set(path, contents);
    });
    const forcedRemovals: string[] = [];
    mocks.rmSync.mockImplementation((path: string, options?: { force?: boolean }) => {
      // Removing the migrated repo target during rollback is what fails.
      if (path === repoNew && options?.force !== true) throw new Error('target removal failed');
      if (options?.force === true) forcedRemovals.push(path);
      files.delete(path);
    });

    expect(() => {
      migrateMachineDataFiles('old', 'new');
    }).toThrow(AggregateError);

    // The source it had just restored is force-removed rather than left as a duplicate.
    expect(forcedRemovals).toContain(repoOld);
  });

  it('rolls back a completed repo migration when the pending migration fails', () => {
    const repoOld = join('/home/test', '.config', 'aitrack', 'repo', 'data', 'old.json');
    const repoNew = join('/home/test', '.config', 'aitrack', 'repo', 'data', 'new.json');
    const pendingOld = join('/home/test', '.config', 'aitrack', 'pending', 'data', 'old.json');
    const pendingNew = join('/home/test', '.config', 'aitrack', 'pending', 'data', 'new.json');
    const original = JSON.stringify({ hostname: 'old', lastUpdated: 'now', days: {} });
    const files = new Map<string, string>([
      [repoOld, original],
      [pendingOld, original],
    ]);
    mocks.existsSync.mockImplementation((path: string) => files.has(path));
    mocks.readFileSync.mockImplementation((path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`missing ${path}`);
      return contents;
    });
    mocks.writeFileSync.mockImplementation((path: string, contents: string) => {
      if (path === pendingNew) throw new Error('pending write failed');
      files.set(path, contents);
    });
    mocks.rmSync.mockImplementation((path: string) => {
      files.delete(path);
    });

    expect(() => {
      migrateMachineDataFiles('old', 'new');
    }).toThrow('pending write failed');

    expect(files.get(repoOld)).toBe(original);
    expect(files.get(pendingOld)).toBe(original);
    expect(files.has(repoNew)).toBe(false);
    expect(files.has(pendingNew)).toBe(false);
  });
});

it('surfaces git failures including stdout-only diagnostics', () => {
  mocks.spawnSync.mockReturnValue({ status: 1, stdout: ' rejected ', stderr: '' });
  expect(() => runGit(['status'])).toThrow('rejected');
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: ' clean ' });
  expect(runGit(['status'])).toBe('clean');
});
it('recovers an own-file rebase conflict and aborts unrelated concurrent conflicts', async () => {
  mocks.execFile.mockReset();
  mocks.existsSync.mockReturnValue(true);
  asyncGitReplies(
    { status: 1, stderr: 'non-fast-forward' },
    { status: 1, stderr: 'conflict' },
    { status: 0, stdout: 'data/host.json\n' },
    { status: 0 },
    { status: 0 },
    { status: 0 },
  );
  await pushWithRetry({ path: 'data/host.json', contents: 'snapshot' }, {}, true);
  expect(mocks.writeFileSync).toHaveBeenCalledWith(
    join('/home/test/.config/aitrack/repo', 'data/host.json'),
    'snapshot',
    'utf8',
  );
  mocks.execFile.mockReset();
  asyncGitReplies(
    { status: 1, stderr: 'fetch first' },
    { status: 1, stderr: 'conflict' },
    { status: 0, stdout: 'unrelated.txt\n' },
    { status: 1 },
  );
  await expect(pushWithRetry(undefined, {}, true)).rejects.toThrow('could not be replayed safely');
  expect(isRebaseInProgress()).toBe(true);
  mocks.existsSync.mockReturnValue(false);
  expect(isRebaseInProgress()).toBe(false);
});
it('rejects asynchronous git failures with non-numeric exit codes', async () => {
  mocks.execFile.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (...values: unknown[]) => void,
    ) => {
      queueMicrotask(() => {
        callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', 'not found');
      });
    },
  );
  await expect(runGitAsync(['status'])).rejects.toThrow('exit code null: not found');
});
