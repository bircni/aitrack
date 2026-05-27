import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prompts: vi.fn(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  isCloned: vi.fn(),
  cloneRepo: vi.fn(),
  removeLocalClone: vi.fn(),
  mkdirSync: vi.fn(),
  adoptPendingDataFiles: vi.fn(),
}));

vi.mock('os', () => ({ hostname: () => 'test-host' }));
vi.mock('prompts', () => ({ default: mocks.prompts }));
vi.mock('fs', () => ({ mkdirSync: mocks.mkdirSync }));
vi.mock('./config.js', () => ({
  loadConfig: mocks.loadConfig,
  saveConfig: mocks.saveConfig,
}));
vi.mock('./git.js', () => ({
  LOCAL_REPO: '/home/test/.config/aitrack/repo',
  isCloned: mocks.isCloned,
  cloneRepo: mocks.cloneRepo,
  removeLocalClone: mocks.removeLocalClone,
  adoptPendingDataFiles: mocks.adoptPendingDataFiles,
}));

import { initCommand } from './init.js';

describe('initCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockImplementation(() => {
      throw new Error('missing');
    });
    mocks.isCloned.mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('clones and saves a trimmed repo URL for a new config', async () => {
    mocks.isCloned
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
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
      '/home/test/.config/aitrack/repo/data',
    );
  });

  it('aborts when an existing config is not overwritten', async () => {
    mocks.loadConfig.mockReturnValue({ repoUrl: 'old' });
    mocks.prompts.mockResolvedValueOnce({ overwrite: false });

    await initCommand();

    expect(mocks.prompts).toHaveBeenCalledTimes(1);
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('overwrites an existing config and skips cloning when the URL is unchanged', async () => {
    mocks.loadConfig.mockReturnValue({ repoUrl: 'same-url', machineId: 'my-pc' });
    mocks.isCloned.mockReturnValue(true);
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'same-url' })
      .mockResolvedValueOnce({ machineId: 'my-pc' });

    await initCommand();

    expect(mocks.removeLocalClone).not.toHaveBeenCalled();
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: 'same-url', machineId: 'my-pc' });
  });

  it('re-clones when the repo URL changes and the user confirms', async () => {
    mocks.loadConfig.mockReturnValue({ repoUrl: 'old-url', machineId: 'my-pc' });
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
    mocks.loadConfig.mockReturnValue({ repoUrl: 'old-url' });
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
});
