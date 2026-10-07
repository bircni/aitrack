import { join } from 'node:path';

import type { Config } from 'aitrack-lib/configTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prompts: vi.fn(),
  readConfig: vi.fn(),
  cloneOriginUrl: vi.fn(),
  saveConfig: vi.fn(),
  isCloned: vi.fn(),
  cloneRepo: vi.fn(),
  removeLocalClone: vi.fn(),
  mkdirSync: vi.fn(),
  adoptPendingDataFiles: vi.fn(),
  migrateMachineDataFiles: vi.fn(),
}));

vi.mock('os', () => ({ hostname: () => 'test-host' }));
vi.mock('prompts', () => ({ default: mocks.prompts }));
vi.mock('fs', () => ({ mkdirSync: mocks.mkdirSync }));
vi.mock('aitrack-lib/config', () => ({
  readConfig: mocks.readConfig,
  describeInvalidConfig: (reason: string) => `Config at /config.json is ${reason}.`,
  localMachineId: () => 'test-host',
  resolveMachineId: (config: { machineId?: string } | null) => config?.machineId ?? 'test-host',
  saveConfig: mocks.saveConfig,
}));
vi.mock('aitrack-lib/git', () => ({
  LOCAL_REPO: '/home/test/.config/aitrack/repo',
  isCloned: mocks.isCloned,
  cloneOriginUrl: mocks.cloneOriginUrl,
  cloneRepo: mocks.cloneRepo,
  removeLocalClone: mocks.removeLocalClone,
  adoptPendingDataFiles: mocks.adoptPendingDataFiles,
  migrateMachineDataFiles: mocks.migrateMachineDataFiles,
}));

import { initCommand } from '../init.js';

function okConfig(config: Config): void {
  mocks.readConfig.mockReturnValue({ status: 'ok', config });
}

describe('initCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.migrateMachineDataFiles.mockReset();
    mocks.readConfig.mockReturnValue({ status: 'missing' });
    mocks.isCloned.mockReturnValue(false);
    mocks.cloneOriginUrl.mockReturnValue('same-url');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('clones and saves a trimmed repo URL for a new config', async () => {
    mocks.isCloned.mockReturnValue(false);
    mocks.prompts
      .mockResolvedValueOnce({ repoUrl: '  git@example.com:me/data.git  ' })
      .mockResolvedValueOnce({ machineId: 'work-laptop' });

    await initCommand();

    expect(mocks.mkdirSync).toHaveBeenCalledWith('/home/test/.config/aitrack', {
      recursive: true,
    });
    expect(mocks.cloneRepo).toHaveBeenCalledWith('git@example.com:me/data.git');
    expect(mocks.saveConfig).toHaveBeenCalledWith({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'work-laptop',
    });
    expect(mocks.adoptPendingDataFiles).toHaveBeenCalledWith(
      join('/home/test/.config/aitrack/repo', 'data'),
    );
    expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('test-host', 'work-laptop');
  });

  it('aborts when an existing config is not overwritten', async () => {
    okConfig({ repoUrl: 'old' });
    mocks.prompts.mockResolvedValueOnce({ overwrite: false });

    await initCommand();

    expect(mocks.prompts).toHaveBeenCalledTimes(1);
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('keeps existing source and budget settings when re-running init', async () => {
    okConfig({
      repoUrl: 'same-url',
      machineId: 'my-pc',
      claudeProjectsDir: '/custom/claude',
      codexSessionsDir: '/custom/codex',
      budget: { monthlyUSD: 200 },
    });
    mocks.isCloned.mockReturnValue(true);
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'same-url' })
      .mockResolvedValueOnce({ machineId: 'my-pc' });

    await initCommand();

    expect(mocks.saveConfig).toHaveBeenCalledWith({
      repoUrl: 'same-url',
      machineId: 'my-pc',
      claudeProjectsDir: '/custom/claude',
      codexSessionsDir: '/custom/codex',
      budget: { monthlyUSD: 200 },
    });
  });

  it('overwrites an existing config and skips cloning when the URL is unchanged', async () => {
    okConfig({ repoUrl: 'same-url', machineId: 'my-pc' });
    mocks.isCloned.mockReturnValue(true);
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'same-url' })
      .mockResolvedValueOnce({ machineId: 'my-pc' });

    await initCommand();

    expect(mocks.removeLocalClone).not.toHaveBeenCalled();
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: 'same-url', machineId: 'my-pc' });
    expect(mocks.adoptPendingDataFiles).not.toHaveBeenCalled();
    expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('my-pc', 'my-pc');
  });

  it('adopts pending data when machineId was configured before the first clone', async () => {
    okConfig({ repoUrl: '', machineId: 'work-laptop' });
    mocks.isCloned.mockReturnValue(false);
    mocks.adoptPendingDataFiles.mockReturnValue(1);
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'git@example.com:me/data.git' })
      .mockResolvedValueOnce({ machineId: 'work-laptop' });

    await initCommand();

    expect(mocks.cloneRepo).toHaveBeenCalledWith('git@example.com:me/data.git');
    expect(mocks.adoptPendingDataFiles).toHaveBeenCalledWith(
      join('/home/test/.config/aitrack/repo', 'data'),
    );
    expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('work-laptop', 'work-laptop');
    expect(mocks.saveConfig).toHaveBeenCalledWith({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'work-laptop',
    });
  });

  it('migrates a later machineId change without re-adopting staged duplicates', async () => {
    okConfig({ repoUrl: 'same-url', machineId: 'old-pc' });
    mocks.isCloned.mockReturnValue(true);
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'same-url' })
      .mockResolvedValueOnce({ machineId: 'Work Laptop_01.2' });

    await initCommand();

    expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('old-pc', 'Work Laptop_01.2');
    expect(mocks.adoptPendingDataFiles).not.toHaveBeenCalled();
    expect(mocks.saveConfig).toHaveBeenCalledWith({
      repoUrl: 'same-url',
      machineId: 'Work Laptop_01.2',
    });
  });

  it('rejects an unsafe custom machineId without saving config', async () => {
    mocks.isCloned.mockReturnValue(false);
    mocks.prompts
      .mockResolvedValueOnce({ repoUrl: 'git@example.com:me/data.git' })
      .mockResolvedValueOnce({ machineId: '../../escape' });

    await expect(initCommand()).rejects.toThrow('Machine name');

    expect(mocks.migrateMachineDataFiles).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('does not save a new machineId when its data destination conflicts', async () => {
    okConfig({ repoUrl: 'same-url', machineId: 'old-pc' });
    mocks.isCloned.mockReturnValue(true);
    mocks.migrateMachineDataFiles.mockImplementation(() => {
      throw new Error('already exists');
    });
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'same-url' })
      .mockResolvedValueOnce({ machineId: 'new-pc' });

    await expect(initCommand()).rejects.toThrow('already exists');

    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('re-clones when the repo URL changes and the user confirms', async () => {
    okConfig({ repoUrl: 'old-url', machineId: 'my-pc' });
    mocks.isCloned.mockReturnValue(true);
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'new-url' })
      .mockResolvedValueOnce({ reclone: true })
      .mockResolvedValueOnce({ machineId: 'my-pc' });

    await initCommand();

    expect(mocks.removeLocalClone).toHaveBeenCalled();
    expect(mocks.cloneRepo).toHaveBeenCalledWith('new-url');
    expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: 'new-url', machineId: 'my-pc' });
  });

  it('aborts when the repo URL changes and the user declines re-clone', async () => {
    okConfig({ repoUrl: 'old-url' });
    mocks.isCloned.mockReturnValue(true);
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'new-url' })
      .mockResolvedValueOnce({ reclone: false });

    await initCommand();

    expect(mocks.removeLocalClone).not.toHaveBeenCalled();
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('aborts when no repo URL is entered', async () => {
    mocks.prompts.mockResolvedValueOnce({ repoUrl: '' });

    await initCommand();

    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('asks before overwriting an invalid config', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.readConfig.mockReturnValue({ status: 'invalid', reason: 'not valid JSON' });
    mocks.prompts.mockResolvedValueOnce({ overwrite: false });

    await initCommand();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not valid JSON'));
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('compares a new URL with the clone remote when no config is readable', async () => {
    mocks.isCloned.mockReturnValue(true);
    mocks.cloneOriginUrl.mockReturnValue('old-url');
    mocks.prompts
      .mockResolvedValueOnce({ repoUrl: 'new-url' })
      .mockResolvedValueOnce({ reclone: false });

    await initCommand();

    expect(mocks.prompts).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'reclone' }));
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
  });

  it('keeps a clone whose origin URL cannot be read', async () => {
    mocks.isCloned.mockReturnValue(true);
    mocks.cloneOriginUrl.mockReturnValue(null);
    mocks.prompts
      .mockResolvedValueOnce({ repoUrl: 'new-url' })
      .mockResolvedValueOnce({ machineId: 'my-pc' });

    await initCommand();

    expect(mocks.removeLocalClone).not.toHaveBeenCalled();
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
  });

  it('validates interactive URL and machine names and reports adopted pending files', async () => {
    mocks.prompts
      .mockReset()
      .mockResolvedValueOnce({ repoUrl: 'repo' })
      .mockResolvedValueOnce({ machineId: 'box' });
    mocks.adoptPendingDataFiles.mockReturnValue(2);
    await initCommand();
    const url = mocks.prompts.mock.calls[0]?.[0] as {
      validate: (value: string) => string | boolean;
    };
    const machine = mocks.prompts.mock.calls[1]?.[0] as {
      validate: (value: string) => string | boolean;
    };
    expect(url.validate('  ')).toBe('URL is required');
    expect(url.validate('repo')).toBe(true);
    expect(machine.validate('box')).toBe(true);
    expect(machine.validate('../escape')).toContain('Machine');
    expect(console.log).toHaveBeenCalledWith('Adopted 2 pending data file(s) into the repo.');
  });
});
