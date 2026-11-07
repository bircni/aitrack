import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before module loading, so TEST_HOME is available in the vi.mock factory below
const TEST_HOME = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'aitrack-config-test-'));
});

const osMock = vi.hoisted(() => ({ hostname: 'MB-Pro-M4.int.example.com' }));
const DEFAULT_HOSTNAME = osMock.hostname;

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

const CONFIG_DIR = join(TEST_HOME, '.config', 'aitrack');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function writeRawConfig(raw: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, raw, 'utf8');
}

describe('config', () => {
  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(CONFIG_PATH, { recursive: true, force: true });
  });

  it.each([
    { repoUrl: 'git@github.com:test/repo.git' },
    {
      repoUrl: 'git@github.com:test/repo.git',
      machineId: 'Work Laptop_01.2',
      claudeProjectsDir: '/data/claude-a,/data/claude-b',
      codexSessionsDir: '/data/codex',
      budget: { monthlyUSD: 5 },
    },
  ])('round-trips %j through save and load', (config) => {
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
  });

  it('rejects an unsafe machineId before saving', () => {
    expect(() => {
      saveConfig({ repoUrl: 'git@example.com:test/repo.git', machineId: '../escape' });
    }).toThrow('Machine name');
    expect(tryLoadConfig()).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'saves through a symlink and keeps a restricted mode',
    () => {
      const real = join(TEST_HOME, 'dotfiles-config.json');
      writeFileSync(real, '{}', { mode: 0o600 });
      mkdirSync(join(TEST_HOME, '.config', 'aitrack'), { recursive: true });
      symlinkSync(real, CONFIG_PATH);

      saveConfig({ repoUrl: 'git@example.com:test/repo.git' });

      expect(lstatSync(CONFIG_PATH).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({
        repoUrl: 'git@example.com:test/repo.git',
      });
      expect(statSync(real).mode & 0o777).toBe(0o600);
      rmSync(real);
    },
  );

  it('leaves no temp file behind when saving fails', () => {
    mkdirSync(CONFIG_PATH, { recursive: true }); // Renaming over a directory fails.

    expect(() => {
      saveConfig({ repoUrl: 'x' });
    }).toThrow(/EISDIR|EPERM|ENOTEMPTY/u);

    expect(readdirSync(join(TEST_HOME, '.config', 'aitrack'))).toEqual(['config.json']);
  });

  it('warns once that an invalid config is being ignored', async () => {
    vi.resetModules(); // The warning is once per process.
    const fresh = await import('../config.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeRawConfig('{ "repoUrl": "x", }');

    expect(fresh.tryLoadConfig()).toBeNull();
    expect(fresh.tryLoadConfig()).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    warn.mockRestore();
  });

  it('resolveMachineId uses configured machineId', () => {
    expect(resolveMachineId({ machineId: 'work-laptop' })).toBe('work-laptop');
  });

  it('rejects an unsafe machineId passed directly to resolveMachineId', () => {
    expect(() => resolveMachineId({ machineId: '../../escape' })).toThrow('Machine name');
  });

  it('throws when no config file exists', () => {
    expect(() => loadConfig()).toThrow('No config found');
    expect(tryLoadConfig()).toBeNull();
  });

  it('reports an unreadable config as invalid, not missing', () => {
    mkdirSync(CONFIG_PATH, { recursive: true });
    expect(() => loadConfig()).toThrow(/is unreadable \(.*EISDIR/u);
  });

  it('rejects malformed JSON', () => {
    writeRawConfig('{ not valid json');
    expect(tryLoadConfig()).toBeNull();
    expect(() => loadConfig()).toThrow('not valid JSON');
  });

  it.each([
    'a string',
    { machineId: 'work-laptop' },
    { repoUrl: 123 },
    { repoUrl: 'repo', machineId: '../../escape' },
    { repoUrl: 'repo', machineId: '  ' },
    { repoUrl: 'repo', machineId: 42 },
    { repoUrl: 'repo', claudeProjectsDir: 42 },
    { repoUrl: 'repo', codexSessionsDir: [] },
    { repoUrl: 'repo', budget: null },
    { repoUrl: 'repo', budget: [] },
    { repoUrl: 'repo', budget: 'bad' },
    { repoUrl: 'repo', budget: { monthlyUSD: '5' } },
    { repoUrl: 'repo', budget: { monthlyUSD: -1 } },
    { repoUrl: 'repo', budget: { monthlyUSD: 0 } },
  ])('returns null for invalid config %j', (config) => {
    writeRawConfig(JSON.stringify(config));
    expect(tryLoadConfig()).toBeNull();
  });

  describe('localMachineId', () => {
    afterEach(() => {
      osMock.hostname = DEFAULT_HOSTNAME;
    });

    it('uses the short hostname so network/DNS changes do not fork the identity', () => {
      osMock.hostname = 'MB-Pro-M4.local';
      expect(localMachineId()).toBe('MB-Pro-M4');

      osMock.hostname = 'MB-Pro-M4.int.example.com';
      expect(localMachineId()).toBe('MB-Pro-M4');

      expect(resolveMachineId(null)).toBe('MB-Pro-M4');
    });

    it('keeps a bare or empty hostname unchanged', () => {
      osMock.hostname = 'pridwen';
      expect(localMachineId()).toBe('pridwen');
      osMock.hostname = '';
      expect(localMachineId()).toBe('');
    });
  });
});
