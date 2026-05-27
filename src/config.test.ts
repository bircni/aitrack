import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// vi.hoisted runs before any module is loaded, so its value is available in vi.mock factories
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${tmp}/aitrack-config-test`;
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { loadConfig, saveConfig } from './config.js';

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
    const cfg = { repoUrl: 'git@github.com:test/repo.git' };
    saveConfig(cfg);
    expect(loadConfig()).toEqual(cfg);
  });

  it('overwrites existing config on second save', () => {
    saveConfig({ repoUrl: 'old' });
    saveConfig({ repoUrl: 'new' });
    expect(loadConfig()).toEqual({ repoUrl: 'new' });
  });

  it('throws when no config file exists', () => {
    expect(() => loadConfig()).toThrow('No config found');
  });
});
