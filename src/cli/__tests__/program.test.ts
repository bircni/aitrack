import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initCommand: vi.fn(),
  syncCommand: vi.fn(),
  showCommand: vi.fn(),
  usageCommand: vi.fn(),
  exportCommand: vi.fn(),
  daemonCommand: vi.fn(),
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
vi.mock('../../commands/daemon.js', () => ({ daemonCommand: mocks.daemonCommand }));
vi.mock('../../commands/doctor.js', () => ({ doctorCommand: mocks.doctorCommand }));
vi.mock('../../commands/top.js', () => ({ topCommand: mocks.topCommand }));
vi.mock('../../commands/machines.js', () => ({ machinesCommand: mocks.machinesCommand }));
vi.mock('../../commands/recompute.js', () => ({
  recomputeCostsCommand: mocks.recomputeCostsCommand,
}));
vi.mock('../../commands/config.js', () => ({ configCommand: mocks.configCommand }));

import { buildProgram, runAsync } from '../program.js';

/** Parse user-level args (no node/script prefix) through a fresh program. */
async function run(...arguments_: string[]): Promise<void> {
  await buildProgram().parseAsync(arguments_, { from: 'user' });
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
    expect(buildProgram().version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('wires simple commands', async () => {
    await run('init');
    expect(mocks.initCommand).toHaveBeenCalled();
    await run('sync');
    expect(mocks.syncCommand).toHaveBeenCalled();
    await run('machines');
    expect(mocks.machinesCommand).toHaveBeenCalled();
    await run('recompute-costs');
    expect(mocks.recomputeCostsCommand).toHaveBeenCalled();
    await run('doctor');
    expect(mocks.doctorCommand).toHaveBeenCalledWith({ pricingCheck: undefined });
    await run('doctor', '--pricing-check');
    expect(mocks.doctorCommand).toHaveBeenCalledWith({ pricingCheck: true });
  });

  it('maps show options', async () => {
    await run('show', '--tui', '--dark', '--providers', 'claude,codex');
    expect(mocks.showCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        tui: true,
        dark: true,
        providers: ['claude_code', 'codex'],
        output: 'aitrack.png',
      }),
    );
  });

  it('maps the usage period subcommands', async () => {
    await run('usage', 'today', '--providers', 'cursor');
    expect(mocks.usageCommand).toHaveBeenCalledWith({ period: 'today', providers: ['cursor'] });

    await run('usage', 'last', '5');
    expect(mocks.usageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'last', n: 5 }),
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
      expect.objectContaining({ period: 'week', output: 'out.pdf' }),
    );
  });

  it('maps top options', async () => {
    await run('top', 'models', '--sort', 'tokens', '-n', '5');
    expect(mocks.topCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'models', sort: 'tokens', limit: 5 }),
    );
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
    });

    it('rejects an invalid top kind', async () => {
      await expect(run('top', 'weeks')).rejects.toThrow('exit');
      expect(mocks.topCommand).not.toHaveBeenCalled();
    });

    it('rejects an invalid date', async () => {
      await expect(run('usage', 'date', 'nope')).rejects.toThrow('exit');
      expect(mocks.usageCommand).not.toHaveBeenCalled();
    });

    it('rejects a reversed range', async () => {
      await expect(run('usage', 'range', '2026-06-02', '2026-06-01')).rejects.toThrow('exit');
    });

    it('rejects invalid usage last days', async () => {
      await expect(run('usage', 'last', '0')).rejects.toThrow('exit');
    });
  });

  describe('runAsync', () => {
    it('exits non-zero and prints the error when the handler rejects', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      runAsync(() => Promise.reject(new Error('boom')));
      await new Promise((resolve) => setImmediate(resolve));
      expect(error).toHaveBeenCalledWith('boom');
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
