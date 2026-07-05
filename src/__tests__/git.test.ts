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
  commitAndPush,
  listDataFiles,
  listPendingDataFiles,
  pull,
  readDataFile,
  removePendingMachineFile,
  tryPull,
  writePendingMachineFile,
} from '../git.js';

describe('git helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('writes and lists pending machine files', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['host.json']);

    writePendingMachineFile({ hostname: 'host', lastUpdated: 'now', days: {} });

    expect(mocks.mkdirSync).toHaveBeenCalled();
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(join('pending', 'data', 'host.json')),
      expect.any(String),
      'utf8',
    );
    expect(listPendingDataFiles()).toHaveLength(1);
  });

  it('adopts pending files into the repo data directory', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(['host.json', 'other.json']);

    const adopted = adoptPendingDataFiles('/home/test/.config/aitrack/repo/data');

    expect(adopted).toBe(2);
    expect(mocks.copyFileSync).toHaveBeenCalledTimes(2);
    expect(mocks.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(join('pending', 'data')),
      expect.objectContaining({ recursive: true }),
    );
  });

  it('removes a pending file for a machine id', () => {
    mocks.existsSync.mockReturnValue(true);

    removePendingMachineFile('host');

    expect(mocks.rmSync).toHaveBeenCalledWith(expect.stringContaining('host.json'));
  });
});
