import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('child_process', () => ({ execSync: mocks.execSync }));
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
} from './git.js';

describe('git helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not pull when the remote has no heads', () => {
    mocks.execSync.mockReturnValueOnce(Buffer.from(''));

    pull();

    expect(mocks.execSync).toHaveBeenCalledTimes(1);
    expect(mocks.execSync).toHaveBeenCalledWith(
      'git ls-remote --heads origin',
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('tryPull with quiet does not log when pulling', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.execSync
      .mockReturnValueOnce(Buffer.from('refs/heads/main'))
      .mockReturnValueOnce(Buffer.from(''));

    tryPull({ quiet: true });

    expect(console.log).not.toHaveBeenCalled();
  });

  it('tryPull continues silently when pull fails', () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error('network down');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    tryPull();

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns false when there are no staged data changes', () => {
    mocks.execSync.mockReturnValueOnce(Buffer.from('added')).mockReturnValueOnce(Buffer.from(''));

    expect(commitAndPush('host')).toBe(false);
    expect(mocks.execSync).toHaveBeenCalledTimes(2);
    expect(mocks.execSync.mock.calls[0][0]).toBe('git add data/');
    expect(mocks.execSync.mock.calls[1][0]).toBe('git status --porcelain -- data/');
  });

  it('surfaces commit failures when there are staged data changes', () => {
    const commitError = new Error('missing git identity');
    mocks.execSync
      .mockReturnValueOnce(Buffer.from('added'))
      .mockReturnValueOnce(Buffer.from('A  data/host.json\n'))
      .mockImplementationOnce(() => {
        throw commitError;
      });

    expect(() => commitAndPush('host')).toThrow(commitError);
  });

  it('sets upstream when a normal push fails', () => {
    mocks.execSync
      .mockReturnValueOnce(Buffer.from('added'))
      .mockReturnValueOnce(Buffer.from('A  data/host.json\n'))
      .mockReturnValueOnce(Buffer.from('committed'))
      .mockImplementationOnce(() => {
        throw new Error('no upstream');
      })
      .mockReturnValueOnce(Buffer.from('pushed'));

    expect(commitAndPush('host')).toBe(true);
    expect(mocks.execSync).toHaveBeenLastCalledWith(
      'git push -u origin HEAD',
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
