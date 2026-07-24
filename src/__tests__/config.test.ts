import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before any module is loaded, so its value is available in vi.mock factories
const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-config-test`;
});

const osMock = vi.hoisted(() => ({ hostname: 'MB-Pro-M4.int.example.com' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME, hostname: () => osMock.hostname };
});

import {
  loadConfig,
  localMachineId,
  resolveMachineId,
  saveConfig,
  tryLoadConfig,
} from '../config.js';

describe('config', () => {
  beforeAll(() => mkdirSync(TEST_HOME, { recursive: true }));
  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    // wipe config file between tests
    const configPath = join(TEST_HOME, '.config', 'aitrack', 'config.json');
    if (existsSync(configPath)) rmSync(configPath);
  });

  it('round-trips a config through save and load', () => {
    const config = { repoUrl: 'git@github.com:test/repo.git' };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
  });

  it('overwrites existing config on second save', () => {
    saveConfig({ repoUrl: 'old' });
    saveConfig({ repoUrl: 'new' });
    expect(loadConfig()).toEqual({ repoUrl: 'new' });
  });

  it('round-trips a config with machineId through save and load', () => {
    const config = { repoUrl: 'git@github.com:test/repo.git', machineId: 'Work Laptop_01.2' };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
  });

  it('loads every optional source and daemon setting', () => {
    const config = {
      repoUrl: 'git@github.com:test/repo.git',
      claudeProjectsDir: '/data/claude-a,/data/claude-b',
      codexSessionsDir: '/data/codex',
      daemon: { port: 9090, interval: 30, sync: true },
    };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
  });

  it.each(['../escape', '..\\escape', 'nested/machine', 'bad\0name', 'CON'])(
    'rejects unsafe machineId %j before saving',
    (machineId) => {
      expect(() => {
        saveConfig({ repoUrl: 'git@example.com:test/repo.git', machineId });
      }).toThrow('Machine name');
      expect(tryLoadConfig()).toBeNull();
    },
  );

  it('resolveMachineId falls back to hostname when machineId is unset', () => {
    expect(resolveMachineId({ repoUrl: 'git@github.com:test/repo.git' })).toBeTruthy();
  });

  it('resolveMachineId uses configured machineId', () => {
    expect(
      resolveMachineId({ repoUrl: 'git@github.com:test/repo.git', machineId: 'work-laptop' }),
    ).toBe('work-laptop');
  });

  it('rejects an unsafe machineId passed directly to resolveMachineId', () => {
    expect(() =>
      resolveMachineId({ repoUrl: 'git@github.com:test/repo.git', machineId: '../../escape' }),
    ).toThrow('Machine name');
  });

  it('throws when no config file exists', () => {
    expect(() => loadConfig()).toThrow('No config found');
    expect(tryLoadConfig()).toBeNull();
  });

  function writeRawConfig(raw: string): void {
    const dir = join(TEST_HOME, '.config', 'aitrack');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), raw, 'utf8');
  }

  it('returns null for malformed JSON', () => {
    writeRawConfig('{ not valid json');
    expect(tryLoadConfig()).toBeNull();
  });

  it('returns null when repoUrl is missing or not a string', () => {
    writeRawConfig(JSON.stringify({ machineId: 'work-laptop' }));
    expect(tryLoadConfig()).toBeNull();
    writeRawConfig(JSON.stringify({ repoUrl: 123 }));
    expect(tryLoadConfig()).toBeNull();
  });

  it('returns null when loaded config contains an unsafe machineId', () => {
    writeRawConfig(
      JSON.stringify({ repoUrl: 'git@example.com:test/repo.git', machineId: '../../escape' }),
    );
    expect(tryLoadConfig()).toBeNull();
  });

  it('returns null when the JSON root is not an object', () => {
    writeRawConfig(JSON.stringify('a string'));
    expect(tryLoadConfig()).toBeNull();
  });

  it('returns null when optional daemon fields have invalid types', () => {
    writeRawConfig(
      JSON.stringify({ repoUrl: 'git@example.com:test/repo.git', daemon: { port: 'bad' } }),
    );
    expect(tryLoadConfig()).toBeNull();
  });

  it.each([
    { repoUrl: 'git@example.com:test/repo.git', claudeProjectsDir: 42 },
    { repoUrl: 'git@example.com:test/repo.git', codexSessionsDir: [] },
    { repoUrl: 'git@example.com:test/repo.git', machineId: 42 },
    { repoUrl: 'git@example.com:test/repo.git', daemon: [] },
    { repoUrl: 'git@example.com:test/repo.git', daemon: { sync: 'yes' } },
    { repoUrl: 'git@example.com:test/repo.git', daemon: { interval: 0 } },
    { repoUrl: 'git@example.com:test/repo.git', daemon: { interval: 1.5 } },
  ])('returns null for invalid optional config values: %j', (config) => {
    writeRawConfig(JSON.stringify(config));
    expect(tryLoadConfig()).toBeNull();
  });

  it('returns null when the daemon port exceeds the TCP range', () => {
    writeRawConfig(
      JSON.stringify({ repoUrl: 'git@example.com:test/repo.git', daemon: { port: 65_536 } }),
    );
    expect(tryLoadConfig()).toBeNull();
  });

  describe('localMachineId', () => {
    // The same machine reports different FQDNs per network; keying data files
    // off the FQDN mints a second identity and double-counts every total.
    it('uses the short hostname so network/DNS changes do not fork the identity', () => {
      osMock.hostname = 'MB-Pro-M4.local';
      expect(localMachineId()).toBe('MB-Pro-M4');

      osMock.hostname = 'MB-Pro-M4.int.example.com';
      expect(localMachineId()).toBe('MB-Pro-M4');

      expect(resolveMachineId({ repoUrl: '' })).toBe('MB-Pro-M4');
    });

    it('keeps a bare hostname unchanged', () => {
      osMock.hostname = 'pridwen';
      expect(localMachineId()).toBe('pridwen');
    });
  });
});
