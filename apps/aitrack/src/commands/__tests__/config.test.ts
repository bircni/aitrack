import { loggedOutput } from '@aitrack/test-fixtures';
import type { Config } from 'aitrack-lib/configTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  saveConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  migrateMachineDataFiles: vi.fn(),
}));

vi.mock('aitrack-lib/config', () => ({
  readConfig: mocks.readConfig,
  invalidConfigMessage: (reason: string) => `Config at /config.json is ${reason}.`,
  saveConfig: mocks.saveConfig,
  resolveMachineId: mocks.resolveMachineId,
}));
vi.mock('aitrack-lib/git', () => ({
  migrateMachineDataFiles: mocks.migrateMachineDataFiles,
}));

import { configCommand } from '../config.js';

function okConfig(config: Config): void {
  mocks.readConfig.mockReturnValue({ status: 'ok', config });
}

describe('configCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.migrateMachineDataFiles.mockReset();
    mocks.resolveMachineId.mockReturnValue('resolved-host');
    mocks.readConfig.mockReturnValue({ status: 'missing' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('list', () => {
    it('prints all keys and the resolved machineId', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git' });
      configCommand({ action: 'list' });
      const out = loggedOutput();
      expect(out).toContain('repoUrl = git@example.com:me/d.git');
      expect(out).toContain('machineId =');
      expect(out).toContain('claudeProjectsDir =');
      expect(out).toContain('codexSessionsDir =');
      expect(out).toContain('budget.monthly =');
      expect(out).toContain('resolved-host');
    });

    it('prints the values as JSON', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git', budget: { monthlyUSD: 50 } });
      configCommand({ action: 'list', json: true });
      expect(JSON.parse(loggedOutput())).toEqual({
        command: 'config',
        action: 'list',
        values: {
          repoUrl: 'git@example.com:me/d.git',
          machineId: null,
          claudeProjectsDir: null,
          codexSessionsDir: null,
          compactAfterDays: null,
          encryptData: null,
          'budget.monthly': 50,
        },
        resolvedMachineId: 'resolved-host',
      });
    });

    it('prints a hint when no config exists', () => {
      mocks.readConfig.mockReturnValue({ status: 'missing' });
      configCommand({ action: 'list' });
      expect(loggedOutput()).toContain('aitrack init');
    });
  });

  describe('get', () => {
    it('prints a single value', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git' });
      configCommand({ action: 'get', key: 'repoUrl' });
      expect(loggedOutput()).toBe('git@example.com:me/d.git');
    });

    it('prints a value as JSON, null when unset', () => {
      okConfig({ repoUrl: 'x' });
      configCommand({ action: 'get', key: 'repoUrl', json: true });
      expect(JSON.parse(loggedOutput())).toEqual({
        command: 'config',
        action: 'get',
        key: 'repoUrl',
        value: 'x',
      });
      vi.mocked(console.log).mockClear();
      configCommand({ action: 'get', key: 'machineId', json: true });
      expect(JSON.parse(loggedOutput())).toMatchObject({ key: 'machineId', value: null });
    });

    it('prints empty for an unset value', () => {
      okConfig({ repoUrl: 'x' });
      configCommand({ action: 'get', key: 'machineId' });
      expect(loggedOutput()).toBe('');
    });

    it('prints the configured monthly budget', () => {
      okConfig({ repoUrl: 'x', budget: { monthlyUSD: 200 } });
      configCommand({ action: 'get', key: 'budget.monthly' });
      expect(loggedOutput()).toBe('200');
    });

    it('rejects an unknown key', () => {
      expect(() => {
        configCommand({ action: 'get', key: 'nope' });
      }).toThrow('Unknown config key');
    });
  });

  describe('set', () => {
    it('updates an existing config', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git' });
      configCommand({
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

    it('creates a config when none exists and warns about empty repoUrl', () => {
      mocks.readConfig.mockReturnValue({ status: 'missing' });
      const warn = vi.spyOn(console, 'warn');
      configCommand({ action: 'set', key: 'machineId', value: 'work-laptop' });
      expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('resolved-host', 'work-laptop');
      expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: '', machineId: 'work-laptop' });
      expect(warn).toHaveBeenCalled();
    });

    it('normalizes and migrates a legitimate later machineId change', () => {
      okConfig({
        repoUrl: 'git@example.com:me/d.git',
        machineId: 'old-pc',
      });
      mocks.resolveMachineId.mockReturnValue('old-pc');

      configCommand({ action: 'set', key: 'machineId', value: '  Work Laptop_01.2  ' });

      expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('old-pc', 'Work Laptop_01.2');
      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        machineId: 'Work Laptop_01.2',
      });
    });

    it('sets budget.monthly as a positive dollar amount under budget.monthlyUSD', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git' });

      configCommand({ action: 'set', key: 'budget.monthly', value: '149.99' });

      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        budget: { monthlyUSD: 149.99 },
      });
    });

    it.each(['0', '-5', 'lots'])('rejects a non-positive budget.monthly value %j', (value) => {
      expect(() => {
        configCommand({ action: 'set', key: 'budget.monthly', value });
      }).toThrow('budget.monthly');
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('sets encryptData and compactAfterDays, and clears compaction with "off"', () => {
      okConfig({ repoUrl: 'x' });
      configCommand({ action: 'set', key: 'encryptData', value: 'true' });
      expect(mocks.saveConfig).toHaveBeenLastCalledWith({ repoUrl: 'x', encryptData: true });

      okConfig({ repoUrl: 'x' });
      configCommand({ action: 'set', key: 'compactAfterDays', value: '365' });
      expect(mocks.saveConfig).toHaveBeenLastCalledWith({ repoUrl: 'x', compactAfterDays: 365 });

      okConfig({ repoUrl: 'x', compactAfterDays: 365 });
      configCommand({ action: 'set', key: 'compactAfterDays', value: 'off' });
      expect(mocks.saveConfig).toHaveBeenLastCalledWith({ repoUrl: 'x' });
    });

    it.each([
      ['compactAfterDays', '0'],
      ['compactAfterDays', '1.5'],
      ['encryptData', 'yes'],
    ])('rejects %s = %j', (key, value) => {
      expect(() => {
        configCommand({ action: 'set', key, value });
      }).toThrow(key);
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('rejects an unsafe machineId before migration or save', () => {
      expect(() => {
        configCommand({ action: 'set', key: 'machineId', value: '../escape' });
      }).toThrow('Machine name');
      expect(mocks.migrateMachineDataFiles).not.toHaveBeenCalled();
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('preserves the old config when machine data migration conflicts', () => {
      okConfig({
        repoUrl: 'git@example.com:me/d.git',
        machineId: 'old-pc',
      });
      mocks.resolveMachineId.mockReturnValue('old-pc');
      mocks.migrateMachineDataFiles.mockImplementation(() => {
        throw new Error('already exists');
      });

      expect(() => {
        configCommand({ action: 'set', key: 'machineId', value: 'new-pc' });
      }).toThrow('already exists');

      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses to overwrite an invalid config', () => {
      mocks.readConfig.mockReturnValue({ status: 'invalid', reason: 'not valid JSON' });
      expect(() => {
        configCommand({ action: 'set', key: 'repoUrl', value: 'x' });
      }).toThrow('Config at /config.json is not valid JSON');
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('rejects an unknown key', () => {
      expect(() => {
        configCommand({ action: 'set', key: 'nope', value: 'x' });
      }).toThrow('Unknown config key');
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('requires a value', () => {
      expect(() => {
        configCommand({ action: 'set', key: 'repoUrl', value: undefined });
      }).toThrow('A value is required');
    });
  });
});
