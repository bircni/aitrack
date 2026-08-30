import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loggedOutput } from '../../__tests__/helpers/fixtures.js';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  saveConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  migrateMachineDataFiles: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  tryLoadConfig: mocks.tryLoadConfig,
  saveConfig: mocks.saveConfig,
  resolveMachineId: mocks.resolveMachineId,
}));
vi.mock('../../git.js', () => ({
  migrateMachineDataFiles: mocks.migrateMachineDataFiles,
}));

import { configCommand } from '../config.js';

describe('configCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.migrateMachineDataFiles.mockReset();
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
      const out = loggedOutput();
      expect(out).toContain('repoUrl = git@example.com:me/d.git');
      expect(out).toContain('machineId =');
      expect(out).toContain('claudeProjectsDir =');
      expect(out).toContain('codexSessionsDir =');
      expect(out).toContain('daemon.port =');
      expect(out).toContain('daemon.interval =');
      expect(out).toContain('daemon.sync =');
      expect(out).toContain('budget.monthly =');
      expect(out).toContain('resolved-host');
    });

    it('prints a hint when no config exists', async () => {
      mocks.tryLoadConfig.mockReturnValue(null);
      await configCommand({ action: 'list' });
      expect(loggedOutput()).toContain('aitrack init');
    });
  });

  describe('get', () => {
    it('prints a single value', async () => {
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/d.git' });
      await configCommand({ action: 'get', key: 'repoUrl' });
      expect(loggedOutput()).toBe('git@example.com:me/d.git');
    });

    it('prints empty for an unset value', async () => {
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x' });
      await configCommand({ action: 'get', key: 'machineId' });
      expect(loggedOutput()).toBe('');
    });

    it('prints nested daemon values', async () => {
      mocks.tryLoadConfig.mockReturnValue({
        repoUrl: 'x',
        daemon: { port: 9090, interval: 45, sync: false },
      });
      await configCommand({ action: 'get', key: 'daemon.port' });
      expect(loggedOutput()).toBe('9090');
    });

    it('prints the configured monthly budget', async () => {
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x', budget: { monthlyUSD: 200 } });
      await configCommand({ action: 'get', key: 'budget.monthly' });
      expect(loggedOutput()).toBe('200');
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
      await configCommand({
        action: 'set',
        key: 'claudeProjectsDir',
        value: '/tmp/claude-a,/tmp/claude-b',
      });
      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        claudeProjectsDir: '/tmp/claude-a,/tmp/claude-b',
      });
      expect(loggedOutput()).toContain('Set claudeProjectsDir = /tmp/claude-a,/tmp/claude-b');
    });

    it('creates a config when none exists and warns about empty repoUrl', async () => {
      mocks.tryLoadConfig.mockReturnValue(null);
      const warn = vi.spyOn(console, 'warn');
      await configCommand({ action: 'set', key: 'machineId', value: 'work-laptop' });
      expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('resolved-host', 'work-laptop');
      expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: '', machineId: 'work-laptop' });
      expect(warn).toHaveBeenCalled();
    });

    it('normalizes and migrates a legitimate later machineId change', async () => {
      mocks.tryLoadConfig.mockReturnValue({
        repoUrl: 'git@example.com:me/d.git',
        machineId: 'old-pc',
      });
      mocks.resolveMachineId.mockReturnValue('old-pc');

      await configCommand({ action: 'set', key: 'machineId', value: '  Work Laptop_01.2  ' });

      expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('old-pc', 'Work Laptop_01.2');
      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        machineId: 'Work Laptop_01.2',
      });
    });

    it.each([
      ['daemon.port', '9090', { port: 9090 }],
      ['daemon.interval', '45', { interval: 45 }],
      ['daemon.sync', 'false', { sync: false }],
    ])('sets typed nested %s configuration', async (key, value, daemon) => {
      mocks.tryLoadConfig.mockReturnValue({
        repoUrl: 'git@example.com:me/d.git',
        daemon: { sync: true },
      });

      await configCommand({ action: 'set', key, value });

      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        daemon: { sync: true, ...daemon },
      });
    });

    it.each([
      ['daemon.port', '0'],
      ['daemon.port', '65536'],
      ['daemon.interval', '1.5'],
      ['daemon.sync', 'yes'],
    ])('rejects invalid nested %s value %s', async (key, value) => {
      await expect(configCommand({ action: 'set', key, value })).rejects.toThrow('daemon.');
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('sets budget.monthly as a positive dollar amount under budget.monthlyUSD', async () => {
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/d.git' });

      await configCommand({ action: 'set', key: 'budget.monthly', value: '149.99' });

      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        budget: { monthlyUSD: 149.99 },
      });
    });

    it.each(['0', '-5', 'lots'])(
      'rejects a non-positive budget.monthly value %j',
      async (value) => {
        await expect(
          configCommand({ action: 'set', key: 'budget.monthly', value }),
        ).rejects.toThrow('budget.monthly');
        expect(mocks.saveConfig).not.toHaveBeenCalled();
      },
    );

    it.each(['../escape', '..\\escape', 'nested/machine'])(
      'rejects unsafe machineId %j before migration or save',
      async (value) => {
        await expect(configCommand({ action: 'set', key: 'machineId', value })).rejects.toThrow(
          'Machine name',
        );
        expect(mocks.migrateMachineDataFiles).not.toHaveBeenCalled();
        expect(mocks.saveConfig).not.toHaveBeenCalled();
      },
    );

    it('preserves the old config when machine data migration conflicts', async () => {
      mocks.tryLoadConfig.mockReturnValue({
        repoUrl: 'git@example.com:me/d.git',
        machineId: 'old-pc',
      });
      mocks.resolveMachineId.mockReturnValue('old-pc');
      mocks.migrateMachineDataFiles.mockImplementation(() => {
        throw new Error('already exists');
      });

      await expect(
        configCommand({ action: 'set', key: 'machineId', value: 'new-pc' }),
      ).rejects.toThrow('already exists');

      expect(mocks.saveConfig).not.toHaveBeenCalled();
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
