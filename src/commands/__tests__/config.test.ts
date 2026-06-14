import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  saveConfig: vi.fn(),
  resolveMachineId: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  tryLoadConfig: mocks.tryLoadConfig,
  saveConfig: mocks.saveConfig,
  resolveMachineId: mocks.resolveMachineId,
}));

import { configCommand } from '../config.js';

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

describe('configCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMachineId.mockReturnValue('resolved-host');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('list', () => {
    it('prints all keys and the resolved machineId', async () => {
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/d.git' });
      await configCommand({ action: 'list' });
      const out = output();
      expect(out).toContain('repoUrl = git@example.com:me/d.git');
      expect(out).toContain('machineId =');
      expect(out).toContain('resolved-host');
    });

    it('prints a hint when no config exists', async () => {
      mocks.tryLoadConfig.mockReturnValue(null);
      await configCommand({ action: 'list' });
      expect(output()).toContain('aitrack init');
    });
  });

  describe('get', () => {
    it('prints a single value', async () => {
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/d.git' });
      await configCommand({ action: 'get', key: 'repoUrl' });
      expect(output()).toBe('git@example.com:me/d.git');
    });

    it('prints empty for an unset value', async () => {
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x' });
      await configCommand({ action: 'get', key: 'machineId' });
      expect(output()).toBe('');
    });

    it('rejects an unknown key', async () => {
      await expect(configCommand({ action: 'get', key: 'nope' })).rejects.toThrow(
        'Unknown config key',
      );
    });
  });

  describe('set', () => {
    it('updates an existing config', async () => {
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/d.git' });
      await configCommand({ action: 'set', key: 'machineId', value: 'work-laptop' });
      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        machineId: 'work-laptop',
      });
      expect(output()).toContain('Set machineId = work-laptop');
    });

    it('creates a config when none exists and warns about empty repoUrl', async () => {
      mocks.tryLoadConfig.mockReturnValue(null);
      const warn = vi.spyOn(console, 'warn');
      await configCommand({ action: 'set', key: 'machineId', value: 'work-laptop' });
      expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: '', machineId: 'work-laptop' });
      expect(warn).toHaveBeenCalled();
    });

    it('rejects an unknown key', async () => {
      await expect(configCommand({ action: 'set', key: 'nope', value: 'x' })).rejects.toThrow(
        'Unknown config key',
      );
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('requires a value', async () => {
      await expect(
        configCommand({ action: 'set', key: 'repoUrl', value: undefined }),
      ).rejects.toThrow('A value is required');
    });
  });
});
