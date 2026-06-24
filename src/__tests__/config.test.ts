import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before any module is loaded, so its value is available in vi.mock factories
const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-config-test`;
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { loadConfig, resolveMachineId, saveConfig, tryLoadConfig } from '../config.js';

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
    const config = { repoUrl: 'git@github.com:test/repo.git', machineId: 'work-laptop' };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
  });

  it('resolveMachineId falls back to hostname when machineId is unset', () => {
    expect(resolveMachineId({ repoUrl: 'git@github.com:test/repo.git' })).toBeTruthy();
  });

  it('resolveMachineId uses configured machineId', () => {
    expect(
      resolveMachineId({ repoUrl: 'git@github.com:test/repo.git', machineId: 'work-laptop' }),
    ).toBe('work-laptop');
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

  it('returns null when the JSON root is not an object', () => {
    writeRawConfig(JSON.stringify('a string'));
    expect(tryLoadConfig()).toBeNull();
  });
});
