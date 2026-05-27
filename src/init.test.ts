import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prompts: vi.fn(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  isCloned: vi.fn(),
  cloneRepo: vi.fn(),
  mkdirSync: vi.fn(),
}));

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
    mocks.prompts.mockResolvedValueOnce({ repoUrl: '  git@example.com:me/data.git  ' });

    await initCommand();

    expect(mocks.mkdirSync).toHaveBeenCalledWith('/home/test/.config/aitrack', {
      recursive: true,
    });
    expect(mocks.cloneRepo).toHaveBeenCalledWith('git@example.com:me/data.git');
    expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: 'git@example.com:me/data.git' });
  });

  it('aborts when an existing config is not overwritten', async () => {
    mocks.loadConfig.mockReturnValue({ repoUrl: 'old' });
    mocks.prompts.mockResolvedValueOnce({ overwrite: false });

    await initCommand();

    expect(mocks.prompts).toHaveBeenCalledTimes(1);
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('overwrites an existing config and skips cloning when the repo exists', async () => {
    mocks.loadConfig.mockReturnValue({ repoUrl: 'old' });
    mocks.isCloned.mockReturnValue(true);
    mocks.prompts
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce({ repoUrl: 'new-url' });

    await initCommand();

    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: 'new-url' });
  });

  it('aborts when no repo URL is entered', async () => {
    mocks.prompts.mockResolvedValueOnce({ repoUrl: '' });

    await initCommand();

    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});
