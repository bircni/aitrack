import { CommanderError } from 'commander';
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
  recomputeCosts: vi.fn(),
  listConfig: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  installOpentrackCommand: vi.fn(),
  resolveProjectSelector: vi.fn(),
}));
vi.mock('aitrack-lib/readers/projectResolver', () => ({
  resolveProjectSelector: mocks.resolveProjectSelector,
}));

vi.mock('../../commands/init.js', () => ({ initCommand: mocks.initCommand }));
vi.mock('../../commands/sync.js', () => ({ syncCommand: mocks.syncCommand }));
vi.mock('../../commands/show.js', () => ({ showCommand: mocks.showCommand }));
vi.mock('../../commands/usage.js', () => ({ usageCommand: mocks.usageCommand }));
vi.mock('../../commands/export.js', () => ({ exportCommand: mocks.exportCommand }));
vi.mock('../../commands/doctor.js', () => ({ doctorCommand: mocks.doctorCommand }));
vi.mock('../../commands/top.js', () => ({ topCommand: mocks.topCommand }));
vi.mock('../../commands/machines.js', () => ({ machinesCommand: mocks.machinesCommand }));
vi.mock('aitrack-lib/recompute', () => ({ recomputeCosts: mocks.recomputeCosts }));
vi.mock('../../commands/installOpentrack.js', () => ({
  installOpentrackCommand: mocks.installOpentrackCommand,
}));
vi.mock('../../commands/config.js', () => ({
  CONFIG_KEYS: ['repoUrl', 'machineId', 'claudeProjectsDir', 'codexSessionsDir'],
  listConfig: mocks.listConfig,
  getConfig: mocks.getConfig,
  setConfig: mocks.setConfig,
}));

import { buildProgram, runAsync, runCli } from '../program.js';

/** Parse user-level args (no node/script prefix) through a fresh program. */
async function run(...arguments_: string[]): Promise<void> {
  await buildProgram().parseAsync(arguments_, { from: 'user' });
  // `show` and `export` load their command module via dynamic import, so the
  // handler completes a few microtasks after parseAsync resolves.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

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

describe('buildProgram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const function_ of Object.values(mocks)) function_.mockResolvedValue(undefined);
    mocks.recomputeCosts.mockResolvedValue({ changed: 2, pushed: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wires simple commands', async () => {
    await run('init');
    expect(mocks.initCommand).toHaveBeenCalled();
    await run('sync');
    expect(mocks.syncCommand).toHaveBeenCalledWith({});
    await run('sync', '--dry-run', '--json');
    expect(mocks.syncCommand).toHaveBeenCalledWith({ dryRun: true, json: true });
    await run('sync', '--verify');
    expect(mocks.syncCommand).toHaveBeenCalledWith({ verify: true });
    await run('machines');
    expect(mocks.machinesCommand).toHaveBeenCalledWith({ json: undefined });
    await run('machines', '--json');
    expect(mocks.machinesCommand).toHaveBeenCalledWith({ json: true });
    await run('recompute-costs');
    expect(mocks.recomputeCosts).toHaveBeenCalledWith({ replaceLocal: undefined });
    await run('recompute-costs', '--replace-local');
    expect(mocks.recomputeCosts).toHaveBeenCalledWith({ replaceLocal: true });
    await run('doctor');
    expect(mocks.doctorCommand).toHaveBeenCalledWith({ pricingCheck: undefined, json: undefined });
    await run('doctor', '--pricing-check');
    expect(mocks.doctorCommand).toHaveBeenCalledWith({ pricingCheck: true, json: undefined });
    await run('doctor', '--json');
    expect(mocks.doctorCommand).toHaveBeenCalledWith({ pricingCheck: undefined, json: true });
    await run('install-opentrack', '--dir', '/tmp/apps');
    expect(mocks.installOpentrackCommand).toHaveBeenCalledWith({
      dir: '/tmp/apps',
      json: undefined,
    });
  });

  it('maps show options', async () => {
    await run('show', '--tui', '--dark', '--providers', 'claude,codex', '--year', '2026');
    expect(mocks.showCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        tui: true,
        dark: true,
        providers: ['claude_code', 'codex'],
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

    await run('usage', 'today', '--refresh');
    expect(mocks.usageCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshLive: true }),
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

  it('resolves --dir to a project, defaulting to the current directory', async () => {
    mocks.resolveProjectSelector.mockResolvedValue({ kind: 'project', project: 'acme/widget' });
    await run('usage', 'week', '--dir', '/work/widget');
    expect(mocks.resolveProjectSelector).toHaveBeenLastCalledWith('/work/widget');
    expect(mocks.usageCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: { kind: 'project', project: 'acme/widget' } }),
    );

    await run('usage', 'week', '--dir');
    expect(mocks.resolveProjectSelector).toHaveBeenLastCalledWith(process.cwd());

    await run('usage', 'week');
    expect(mocks.usageCommand).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ project: expect.anything() as unknown }),
    );

    await run('top', 'projects');
    expect(mocks.topCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'projects' }),
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
    await run('top');
    expect(mocks.topCommand).toHaveBeenCalledWith({ kind: 'days', sort: 'cost', limit: 10 });
    await run('top', 'models', '--sort', 'tokens', '-n', '5');
    expect(mocks.topCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'models', sort: 'tokens', limit: 5 }),
    );
    await run('top', 'days', '--json');
    expect(mocks.topCommand).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });

  it('lists every window in export --help', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    buildProgram()
      .commands.find((command) => command.name() === 'export')
      ?.outputHelp();
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    write.mockRestore();
    expect(output).toContain('[window]');
    expect(output).toContain('range <from> <to>');
    expect(output).toContain('last <n>');
  });

  it('wires the config subcommands', async () => {
    await run('config', 'list');
    expect(mocks.listConfig).toHaveBeenCalledWith(undefined);
    await run('config', 'get', 'repoUrl', '--json');
    expect(mocks.getConfig).toHaveBeenCalledWith('repoUrl', true);
    await run('config', 'set', 'machineId', 'box');
    expect(mocks.setConfig).toHaveBeenCalledWith('machineId', 'box');
  });

  describe('validation exits non-zero', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.exitCode = undefined;
    });

    afterEach(() => {
      process.exitCode = undefined;
    });

    it('rejects an invalid usage date', async () => {
      expect(await runAndSettle('usage', 'date', 'nope')).toBe(2);
      expect(mocks.usageCommand).not.toHaveBeenCalled();
    });

    it('exits 2 for commander argument errors', async () => {
      await expect(run('top', 'weeks')).rejects.toThrow(CommanderError);
      expect(process.exitCode).toBe(2);
    });

    it.each([
      [['top', '--json', '--sort', 'bogus'], 'top', "option '--sort <field>' argument 'bogus'"],
      [['usage', 'today', '--json', '--bogus'], 'usage', "unknown option '--bogus'"],
      [['machines', '--json', 'extra'], 'machines', 'too many arguments'],
      [['bogus', '--json'], 'aitrack', "unknown command 'bogus'"],
    ])('keeps parser failure %j machine-readable', async (argv, command, error) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await expect(buildProgram(argv).parseAsync(argv, { from: 'user' })).rejects.toThrow(
        CommanderError,
      );
      expect(process.exitCode).toBe(2);
      expect(log).toHaveBeenCalledTimes(1);
      const document = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, string>;
      expect(document.command).toBe(command);
      expect(document.error).toContain(error);
      expect(document.error).not.toMatch(/^error:/u);
    });

    it('ignores a --json past the -- separator, and sets the exit code from the real entry point', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { argv } = process;
      process.argv = ['node', 'aitrack', 'top', 'x', '--', '--json'];
      try {
        runCli();
      } finally {
        process.argv = argv;
      }
      expect(process.exitCode).toBe(2);
      expect(log).not.toHaveBeenCalled();
      expect(write.mock.calls.join('')).toContain('error:');
      write.mockRestore();
    });

    it('refuses --compare on a window with no previous period, before loading anything', async () => {
      expect(await runAndSettle('usage', 'all', '--compare')).toBe(2);
      expect(mocks.usageCommand).not.toHaveBeenCalled();
    });

    it.each([
      [['--short', '--json'], '--short is ignored with --json.'],
      [['--short', '--compare'], '--compare is ignored with --short.'],
      [['--short', '--compare', '--json'], '--short is ignored with --json.'],
    ])('runs usage %j with a note on stderr', async (flags, note) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await runAndSettle('usage', 'today', ...flags)).toBeUndefined();
      expect(warn.mock.calls.join('')).toBe(note);
      expect(mocks.usageCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          short: true,
          ...(flags.includes('--json') && { json: true }),
          ...(flags.includes('--compare') && { compare: true }),
        }),
      );
    });

    it('still writes -o - to a file of that name, and says so', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await run('export', 'today', '-o', '-');
      await run('show', '-o', '-');
      expect(mocks.exportCommand.mock.calls[0]?.[0]).toMatchObject({ output: '-' });
      expect(mocks.showCommand.mock.calls[0]?.[0]).toMatchObject({ output: '-' });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toContain('cannot write to stdout');
    });

    it('prints a JSON error document in --json mode', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await runAndSettle('usage', 'date', 'nope', '--json')).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        command: 'usage',
        error: expect.stringContaining('nope') as string,
      });
    });

    it('exits 2 when --dir is not a directory', async () => {
      mocks.resolveProjectSelector.mockRejectedValue(new Error('Not a directory: nope'));
      expect(await runAndSettle('usage', 'week', '--dir', 'nope')).toBe(2);
      expect(mocks.usageCommand).not.toHaveBeenCalled();
    });

    it('rejects --watch below the minimum and with --json', async () => {
      await expect(run('usage', 'today', '--watch', '2')).rejects.toThrow(CommanderError);
      expect(await runAndSettle('usage', 'today', '--watch', '--json')).toBe(2);
      expect(mocks.usageCommand).not.toHaveBeenCalled();
    });

    it('rejects malformed options and arguments', async () => {
      await expect(run('show', '--year', '2026junk')).rejects.toThrow(CommanderError);
      await expect(run('top', 'weeks')).rejects.toThrow(CommanderError);
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
