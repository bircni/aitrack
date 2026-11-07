import { loggedOutput } from '@aitrack/test-fixtures';
import type { Config } from 'aitrack-lib/configTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  saveConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  migrateMachineDataFiles: vi.fn(),
  isCloned: vi.fn(),
  cloneOriginUrl: vi.fn(),
}));

vi.mock('aitrack-lib/config', () => ({
  readConfig: mocks.readConfig,
  invalidConfigMessage: (reason: string) => `Config at /config.json is ${reason}.`,
  saveConfig: mocks.saveConfig,
  resolveMachineId: mocks.resolveMachineId,
}));
vi.mock('aitrack-lib/git', () => ({
  LOCAL_REPO: '/repo',
  migrateMachineDataFiles: mocks.migrateMachineDataFiles,
  isCloned: mocks.isCloned,
  cloneOriginUrl: mocks.cloneOriginUrl,
}));

import { UsageError } from '../../cli/errors.js';
import { getConfig, listConfig, setConfig } from '../config.js';

function okConfig(config: Config): void {
  mocks.readConfig.mockReturnValue({ status: 'ok', config });
}

describe('config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.migrateMachineDataFiles.mockReset();
    mocks.resolveMachineId.mockReturnValue('resolved-host');
    mocks.readConfig.mockReturnValue({ status: 'missing' });
    mocks.isCloned.mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('list', () => {
    it('prints all keys and the resolved machineId', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git' });
      listConfig();
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
      listConfig(true);
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
      listConfig();
      expect(loggedOutput()).toContain('aitrack init');
    });
  });

  describe('get', () => {
    it('prints a single value', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git' });
      getConfig('repoUrl');
      expect(loggedOutput()).toBe('git@example.com:me/d.git');
    });

    it('prints a value as JSON, null when unset', () => {
      okConfig({ repoUrl: 'x' });
      getConfig('repoUrl', true);
      expect(JSON.parse(loggedOutput())).toEqual({
        command: 'config',
        action: 'get',
        key: 'repoUrl',
        value: 'x',
      });
      vi.mocked(console.log).mockClear();
      getConfig('machineId', true);
      expect(JSON.parse(loggedOutput())).toMatchObject({ key: 'machineId', value: null });
    });

    it('prints empty for an unset value', () => {
      okConfig({ repoUrl: 'x' });
      getConfig('machineId');
      expect(loggedOutput()).toBe('');
    });

    it('prints the configured monthly budget', () => {
      okConfig({ repoUrl: 'x', budget: { monthlyUSD: 200 } });
      getConfig('budget.monthly');
      expect(loggedOutput()).toBe('200');
    });

    it('rejects an unknown key', () => {
      expect(() => {
        getConfig('nope');
      }).toThrow('Unknown config key');
    });
  });

  describe('set', () => {
    it('updates an existing config', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git' });
      setConfig('claudeProjectsDir', '/tmp/claude-a,/tmp/claude-b');
      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        claudeProjectsDir: '/tmp/claude-a,/tmp/claude-b',
      });
      expect(loggedOutput()).toContain('Set claudeProjectsDir = /tmp/claude-a,/tmp/claude-b');
    });

    it('creates a config when none exists and warns about empty repoUrl', () => {
      mocks.readConfig.mockReturnValue({ status: 'missing' });
      const warn = vi.spyOn(console, 'warn');
      setConfig('machineId', 'work-laptop');
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

      setConfig('machineId', '  Work Laptop_01.2  ');

      expect(mocks.migrateMachineDataFiles).toHaveBeenCalledWith('old-pc', 'Work Laptop_01.2');
      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        machineId: 'Work Laptop_01.2',
      });
    });

    it('sets budget.monthly as a positive dollar amount under budget.monthlyUSD', () => {
      okConfig({ repoUrl: 'git@example.com:me/d.git' });

      setConfig('budget.monthly', '149.99');

      expect(mocks.saveConfig).toHaveBeenCalledWith({
        repoUrl: 'git@example.com:me/d.git',
        budget: { monthlyUSD: 149.99 },
      });
    });

    it.each(['0', '-5', 'lots'])('rejects a non-positive budget.monthly value %j', (value) => {
      expect(() => {
        setConfig('budget.monthly', value);
      }).toThrow('budget.monthly');
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('sets encryptData and compactAfterDays, and clears compaction with "off"', () => {
      okConfig({ repoUrl: 'x' });
      setConfig('encryptData', 'true');
      expect(mocks.saveConfig).toHaveBeenLastCalledWith({ repoUrl: 'x', encryptData: true });

      okConfig({ repoUrl: 'x' });
      setConfig('compactAfterDays', '365');
      expect(mocks.saveConfig).toHaveBeenLastCalledWith({ repoUrl: 'x', compactAfterDays: 365 });

      okConfig({ repoUrl: 'x', compactAfterDays: 365 });
      setConfig('compactAfterDays', 'off');
      expect(mocks.saveConfig).toHaveBeenLastCalledWith({ repoUrl: 'x' });
    });

    it.each([
      ['compactAfterDays', '0'],
      ['compactAfterDays', '1.5'],
      ['encryptData', 'yes'],
    ])('rejects %s = %j', (key, value) => {
      expect(() => {
        setConfig(key, value);
      }).toThrow(key);
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('rejects an unsafe machineId before migration or save', () => {
      expect(() => {
        setConfig('machineId', '../escape');
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
        setConfig('machineId', 'new-pc');
      }).toThrow('already exists');

      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses to overwrite an invalid config', () => {
      mocks.readConfig.mockReturnValue({ status: 'invalid', reason: 'not valid JSON' });
      expect(() => {
        setConfig('repoUrl', 'x');
      }).toThrow('Config at /config.json is not valid JSON');
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('rejects an unknown key', () => {
      expect(() => {
        setConfig('nope', 'x');
      }).toThrow('Unknown config key');
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it.each([
      ['encryptData', 'maybe'],
      ['compactAfterDays', '1e3'],
      ['compactAfterDays', '0x10'],
      ['machineId', '../escape'],
    ])('reports %s = %j as a usage error', (key, value) => {
      expect(() => {
        setConfig(key, value);
      }).toThrow(UsageError);
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    it('clears a monthly budget with "off", naming it cleared', () => {
      okConfig({ repoUrl: 'x', budget: { monthlyUSD: 200 } });
      setConfig('budget.monthly', 'off');
      expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: 'x' });
      expect(loggedOutput()).toContain('Cleared budget.monthly.');
    });

    describe('repoUrl with a clone', () => {
      beforeEach(() => {
        okConfig({ repoUrl: 'old-url' });
        mocks.isCloned.mockReturnValue(true);
        mocks.cloneOriginUrl.mockReturnValue('old-url');
      });

      it('refuses a URL the clone does not push to, leaving the config alone', () => {
        expect(() => {
          setConfig('repoUrl', 'new-url');
        }).toThrow(UsageError);
        expect(() => {
          setConfig('repoUrl', 'new-url');
        }).toThrow('aitrack init --repo');
        expect(mocks.saveConfig).not.toHaveBeenCalled();
      });

      it('allows clearing it, which claims no remote', () => {
        setConfig('repoUrl', '');
        expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: '' });
      });

      it("accepts the clone's remote written another way", () => {
        mocks.cloneOriginUrl.mockReturnValue('git@github.com:me/d.git');
        setConfig('repoUrl', 'https://github.com/me/d');
        expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: 'https://github.com/me/d' });
      });

      it("accepts the clone's own origin, once git was told about the move", () => {
        mocks.cloneOriginUrl.mockReturnValue('new-url');
        setConfig('repoUrl', 'new-url');
        expect(mocks.saveConfig).toHaveBeenCalledWith({ repoUrl: 'new-url' });
      });

      it('redacts credentials from the echo but not from get', () => {
        const url = 'https://me:s3cret@example.test/d.git';
        mocks.cloneOriginUrl.mockReturnValue(url);
        setConfig('repoUrl', url);
        expect(loggedOutput()).toContain('https://***@example.test/d.git');
        expect(loggedOutput()).not.toContain('s3cret');
        okConfig({ repoUrl: url });
        vi.mocked(console.log).mockClear();
        listConfig();
        expect(loggedOutput()).not.toContain('s3cret');
        vi.mocked(console.log).mockClear();
        getConfig('repoUrl');
        expect(loggedOutput()).toContain('s3cret');
      });
    });
  });
});
