import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('child_process', () => ({ spawnSync: mocks.spawnSync }));
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
  cloneRepo,
  commitAndPush,
  hasMachineDataChanges,
  isCloned,
  listDataFiles,
  listPendingDataFiles,
  migrateMachineDataFiles,
  pull,
  readDataFile,
  removeLocalClone,
  removePendingMachineFile,
  tryPull,
  writePendingMachineFile,
} from '../git.js';

describe('git helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects, clones, and removes the local data repository', () => {
    mocks.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mocks.spawnSync.mockReturnValue({ status: 0 });

    expect(isCloned()).toBe(true);
    cloneRepo('git@example.com:me/data.git');
    removeLocalClone();

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'git',
      ['clone', 'git@example.com:me/data.git', expect.stringContaining(join('aitrack', 'repo'))],
      { stdio: 'inherit' },
    );
    expect(mocks.rmSync).toHaveBeenCalledWith(expect.stringContaining(join('aitrack', 'repo')), {
      recursive: true,
      force: true,
    });
  });

  it('surfaces clone failures', () => {
    mocks.spawnSync.mockReturnValue({ status: 1 });

    expect(() => {
      cloneRepo('git@example.com:me/data.git');
    }).toThrow('git clone failed with exit code 1');
  });

  it('does not pull when the remote has no heads', () => {
    mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: '' });

    pull();

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--heads', 'origin'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('pulls fast-forward-only when the remote has a branch', () => {
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'refs/heads/main' })
      .mockReturnValueOnce({ status: 0 });

    pull();

    expect(mocks.spawnSync).toHaveBeenLastCalledWith(
      'git',
      ['pull', '--ff-only', '--quiet'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('tryPull with quiet does not log when pulling', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'refs/heads/main' })
      .mockReturnValueOnce({ status: 0 });

    tryPull({ quiet: true });

    expect(console.log).not.toHaveBeenCalled();
  });

  it('tryPull continues silently when pull fails', () => {
    mocks.spawnSync.mockImplementation(() => {
      throw new Error('network down');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    tryPull();

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns false when there are no staged data changes', () => {
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, stdout: '' });

    expect(commitAndPush('host')).toBe(false);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
    expect(mocks.spawnSync.mock.calls[0]?.[1]).toEqual(['add', 'data/']);
    expect(mocks.spawnSync.mock.calls[1]?.[1]).toEqual(['status', '--porcelain', '--', 'data/']);
  });

  it('surfaces commit failures when there are staged data changes', () => {
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, stdout: 'A  data/host.json\n' })
      .mockReturnValueOnce({ status: 1 });
    expect(() => commitAndPush('host')).toThrow('git commit failed');
  });

  it('sets upstream when a normal push fails', () => {
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, stdout: 'A  data/host.json\n' })
      .mockReturnValueOnce({ status: 0 })
      .mockImplementationOnce(() => {
        throw new Error('no upstream');
      })
      .mockReturnValueOnce({ status: 0 });

    expect(commitAndPush('host')).toBe(true);
    expect(mocks.spawnSync).toHaveBeenLastCalledWith(
      'git',
      ['push', '-u', 'origin', 'HEAD'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('checks literal git status only for a bracketed machine target', () => {
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: '?? data/new-host[1].json\n' });

    expect(hasMachineDataChanges('new-host[1]')).toBe(true);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain', '--', ':(literal)data/new-host[1].json'],
      expect.objectContaining({ stdio: 'pipe' }),
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
      JSON.stringify({ hostname: 'host', lastUpdated: 'now', days: {} }),
    );

    const files = listDataFiles();

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('host.json');
    const file = files[0];
    expect(file).toBeDefined();
    if (file === undefined) throw new Error('expected one data file');
    expect(readDataFile(file)).toEqual({ hostname: 'host', lastUpdated: 'now', days: {} });
  });

  it('writes and lists pending machine files for a legitimate custom id', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['Work Laptop_01.2.json']);

    writePendingMachineFile({ hostname: 'Work Laptop_01.2', lastUpdated: 'now', days: {} });

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
        writePendingMachineFile({ hostname, lastUpdated: 'now', days: {} });
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

  it('does not overwrite an existing file while adopting pending data', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['host.json']);

    expect(() => adoptPendingDataFiles('/home/test/.config/aitrack/repo/data')).toThrow(
      'already exists',
    );
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('rejects an unsafe pending filename before adopting it', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['..\\escape.json']);

    expect(() => adoptPendingDataFiles('/home/test/.config/aitrack/repo/data')).toThrow(
      'not safe in a filename',
    );
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
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
