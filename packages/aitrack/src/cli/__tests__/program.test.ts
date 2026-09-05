import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initCommand: vi.fn(),
  syncCommand: vi.fn(),
  showCommand: vi.fn(),
  usageCommand: vi.fn(),
  exportCommand: vi.fn(),
  doctorCommand: vi.fn(),
  topCommand: vi.fn(),
  machinesCommand: vi.fn(),
  recomputeCostsCommand: vi.fn(),
  configCommand: vi.fn(),
}));

vi.mock('../../commands/init.js', () => ({ initCommand: mocks.initCommand }));
vi.mock('../../commands/sync.js', () => ({ syncCommand: mocks.syncCommand }));
vi.mock('../../commands/show.js', () => ({ showCommand: mocks.showCommand }));
vi.mock('../../commands/usage.js', () => ({ usageCommand: mocks.usageCommand }));
vi.mock('../../commands/export.js', () => ({ exportCommand: mocks.exportCommand }));
vi.mock('../../commands/doctor.js', () => ({ doctorCommand: mocks.doctorCommand }));
vi.mock('../../commands/top.js', () => ({ topCommand: mocks.topCommand }));
vi.mock('../../commands/machines.js', () => ({ machinesCommand: mocks.machinesCommand }));
vi.mock('../../commands/recompute.js', () => ({
  recomputeCostsCommand: mocks.recomputeCostsCommand,
}));
vi.mock('../../commands/config.js', () => ({
  CONFIG_KEYS: ['repoUrl', 'machineId', 'claudeProjectsDir', 'codexSessionsDir'],
  configCommand: mocks.configCommand,
}));

import { buildProgram, runAsync } from '../program.js';

/** Parse user-level args (no node/script prefix) through a fresh program. */
async function run(...arguments_: string[]): Promise<void> {
  await buildProgram().parseAsync(arguments_, { from: 'user' });
  // `show` and `export` load their command module via dynamic import, so the
  // handler completes a few microtasks after parseAsync resolves.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('buildProgram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const function_ of Object.values(mocks)) function_.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the package version', () => {
    expect(buildProgram().version()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('wires simple commands', async () => {
    await run('init');
    expect(mocks.initCommand).toHaveBeenCalled();
    await run('sync');
    expect(mocks.syncCommand).toHaveBeenCalledWith({ dryRun: undefined });
    await run('sync', '--dry-run');
    expect(mocks.syncCommand).toHaveBeenCalledWith({ dryRun: true });
    await run('machines');
    expect(mocks.machinesCommand).toHaveBeenCalledWith({ json: undefined });
    await run('machines', '--json');
    expect(mocks.machinesCommand).toHaveBeenCalledWith({ json: true });
    await run('recompute-costs');
    expect(mocks.recomputeCostsCommand).toHaveBeenCalled();
    await run('doctor');
    expect(mocks.doctorCommand).toHaveBeenCalledWith({ pricingCheck: undefined, json: undefined });
    await run('doctor', '--pricing-check');
    expect(mocks.doctorCommand).toHaveBeenCalledWith({ pricingCheck: true, json: undefined });
    await run('doctor', '--json');
    expect(mocks.doctorCommand).toHaveBeenCalledWith({ pricingCheck: undefined, json: true });
  });

  it('maps show options', async () => {
    await run('show', '--tui', '--dark', '--providers', 'claude,codex', '--year', '2026');
    expect(mocks.showCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        tui: true,
        dark: true,
        providers: ['claude_code', 'codex'],
        output: 'aitrack.png',
        year: 2026,
      }),
    );
  });

  it('maps the usage period subcommands', async () => {
    await run('usage', 'today', '--providers', 'cursor', '--json');
    expect(mocks.usageCommand).toHaveBeenCalledWith({
      period: 'today',
      providers: ['cursor'],
      json: true,
    });

    await run('usage', 'last', '5');
    expect(mocks.usageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'last', n: 5 }),
    );

    await run('usage', 'thisweek', '--compare');
    expect(mocks.usageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'thisweek', compare: true }),
    );

    await run('usage', 'date', '2026-06-01');
    expect(mocks.usageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'date', from: '2026-06-01' }),
    );

    await run('usage', 'range', '2026-06-01', '2026-06-02');
    expect(mocks.usageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'range', from: '2026-06-01', to: '2026-06-02' }),
    );
  });

  it('maps export options', async () => {
    await run('export', 'week', '-o', 'out.pdf');
    expect(mocks.exportCommand).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'week', args: [], output: 'out.pdf' }),
    );

    await run('export', 'range', '2026-06-01', '2026-06-02');
    expect(mocks.exportCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        period: 'range',
        args: ['2026-06-01', '2026-06-02'],
      }),
    );
  });

  it('maps top options', async () => {
    await run('top', 'models', '--sort', 'tokens', '-n', '5');
    expect(mocks.topCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'models', sort: 'tokens', limit: 5, json: undefined }),
    );
    await run('top', 'days', '--json');
    expect(mocks.topCommand).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });

  it('wires the config subcommands', async () => {
    await run('config', 'list');
    expect(mocks.configCommand).toHaveBeenCalledWith({ action: 'list' });
    await run('config', 'get', 'repoUrl');
    expect(mocks.configCommand).toHaveBeenCalledWith({ action: 'get', key: 'repoUrl' });
    await run('config', 'set', 'machineId', 'box');
    expect(mocks.configCommand).toHaveBeenCalledWith({
      action: 'set',
      key: 'machineId',
      value: 'box',
    });
  });

  describe('validation exits non-zero', () => {
    beforeEach(() => {
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.exitCode = undefined;
    });

    afterEach(() => {
      process.exitCode = undefined;
    });

    /**
     * Argument errors route through runAsync, which sets exitCode rather than
     * calling process.exit, so stdout can flush before Node leaves.
     */
    async function runAndSettle(...argv: string[]): Promise<typeof process.exitCode> {
      await run(...argv);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      return process.exitCode;
    }

    it('rejects an invalid top kind', async () => {
      expect(await runAndSettle('top', 'weeks')).toBe(1);
      expect(mocks.topCommand).not.toHaveBeenCalled();
    });

    it('rejects an invalid date', async () => {
      expect(await runAndSettle('usage', 'date', 'nope')).toBe(1);
      expect(mocks.usageCommand).not.toHaveBeenCalled();
    });

    it('rejects a reversed range', async () => {
      expect(await runAndSettle('usage', 'range', '2026-06-02', '2026-06-01')).toBe(1);
    });

    it('rejects invalid usage last days', async () => {
      expect(await runAndSettle('usage', 'last', '0')).toBe(1);
    });

    it('rejects malformed and non-positive numeric options', async () => {
      await expect(run('show', '--year', '2026junk')).rejects.toThrow('exit');
      await expect(run('top', '--year', '0')).rejects.toThrow('exit');
      expect(mocks.showCommand).not.toHaveBeenCalled();
      expect(mocks.topCommand).not.toHaveBeenCalled();
    });
  });

  describe('runAsync', () => {
    afterEach(() => {
      process.exitCode = undefined;
    });

    it('exits non-zero and prints the error when the handler rejects', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.exitCode = undefined;
      runAsync(() => Promise.reject(new Error('boom')));
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(error).toHaveBeenCalledWith('boom');
      expect(process.exitCode).toBe(1);
    });

    it('reports a handler that throws synchronously', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.exitCode = undefined;
      runAsync(() => {
        throw new Error('sync boom');
      });
      expect(error).toHaveBeenCalledWith('sync boom');
      expect(process.exitCode).toBe(1);
    });
  });
});
