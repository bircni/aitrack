import { errorMessage } from 'aitrack-lib/errors';
import { log } from 'aitrack-lib/output';
import { Command } from 'commander';

import { CONFIG_KEYS, configCommand } from '../commands/config.js';
import { daemonCommand, type DaemonOptions } from '../commands/daemon.js';
import { doctorCommand } from '../commands/doctor.js';
import type { ExportOptions } from '../commands/export.js';
import { initCommand } from '../commands/init.js';
import { machinesCommand } from '../commands/machines.js';
import { recomputeCostsCommand } from '../commands/recompute.js';
import type { ShowOptions } from '../commands/show.js';
import { syncCommand } from '../commands/sync.js';
import { topCommand } from '../commands/top.js';
import { cliVersion } from '../version.js';
import {
  parseDateOption,
  parseIntArgument,
  parsePortArgument,
  parseIntervalArgument,
  parsePositiveIntArgument,
  parseProviders,
  parseTopKind,
  parseTopLimit,
  parseTopSort,
} from './parse.js';
import {
  PROVIDERS_DESC,
  PROVIDERS_FLAG,
  REFRESH_DESC,
  REFRESH_FLAG,
  registerUsageCommands,
} from './usageCommands.js';

/**
 * Run an async command handler, printing a friendly error and exiting with a
 * non-zero status if it rejects. Centralises the catch/exit boilerplate shared
 * by every CLI action.
 */
export function runAsync(function_: () => Promise<void>): void {
  // `exitCode` rather than `exit`: it lets buffered stdout flush before Node
  // leaves, which `process.exit` can truncate.
  try {
    function_().catch(fail);
  } catch (error) {
    fail(error);
  }
}

function fail(error: unknown): void {
  log.error(errorMessage(error));
  process.exitCode = 1;
}

interface TopCliOptions {
  limit: number;
  sort: string;
  providers?: string[];
  year?: number;
  since?: string;
  until?: string;
  refresh?: boolean;
  json?: boolean;
}

/**
 * Parsing happens inside the async body so a bad argument travels through
 * `runAsync` like every other failure, instead of duplicating its catch-and-exit.
 */
function runTop(kind: string | undefined, options: TopCliOptions): void {
  runAsync(() =>
    topCommand({
      kind: parseTopKind(kind),
      limit: parseTopLimit(options.limit),
      sort: parseTopSort(options.sort),
      providers: options.providers,
      year: options.year,
      since: options.since,
      until: options.until,
      refresh: options.refresh,
      json: options.json,
    }),
  );
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('aitrack')
    .description('Sync AI coding assistant usage across machines via a git remote')
    .version(cliVersion());

  program
    .command('init')
    .description('Interactive setup: configure git remote and clone repo')
    .action(() => {
      runAsync(initCommand);
    });

  program
    .command('sync')
    .description('Read local AI usage data and push to git repo')
    .option('--dry-run', 'show whether data would change without writing, committing, or pushing')
    .action((options: { dryRun?: boolean }) => {
      runAsync(() => syncCommand({ dryRun: options.dryRun }));
    });

  program
    .command('show')
    .description(
      'Merge local usage with already-synced machine data and render a heatmap PNG (or terminal table with --tui)',
    )
    .option('-o, --output <path>', 'output file path', 'aitrack.png')
    .option('--dark', 'dark mode output')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option('--all', 'single merged heatmap across all providers instead of one row per provider')
    .option('--no-open', 'do not auto-open the generated PNG (useful for scripts / CI)')
    .option('--year <year>', 'only include days from this calendar year', parsePositiveIntArgument)
    .option(REFRESH_FLAG, REFRESH_DESC)
    .option('--tui', 'render a stats table in the terminal instead of a PNG')
    .action((options: ShowOptions) => {
      runAsync(async () => {
        // Loaded on demand so `@napi-rs/canvas` (a native binding) stays off
        // the startup path of every other command.
        const { showCommand } = await import('../commands/show.js');
        await showCommand(options);
      });
    });

  const usage = program
    .command('usage')
    .description('Show usage broken down by provider and model over a fixed time window');
  registerUsageCommands(usage, runAsync);

  program
    .command('export [period] [args...]')
    .description('Export an itemized usage receipt for a period (default: month) as PDF or CSV')
    .option('-o, --output <path>', 'output path (.pdf, or .csv with --csv)', 'aitrack-receipt.pdf')
    .option('--csv', 'write a spreadsheet-friendly CSV instead of the PDF receipt')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option(REFRESH_FLAG, REFRESH_DESC)
    .action((period: string | undefined, args: string[], options: ExportOptions) => {
      runAsync(async () => {
        // Loaded on demand so `pdfkit` stays off the startup path of every
        // other command.
        const { exportCommand } = await import('../commands/export.js');
        await exportCommand({ ...options, period, args });
      });
    });

  program
    .command('daemon')
    .description('Run a local HTTP dashboard that refreshes usage data on an interval')
    .option('--port <port>', 'HTTP listen port', parsePortArgument)
    .option('--interval <seconds>', 'seconds between data refresh ticks', parseIntervalArgument)
    .option('--host <host>', 'bind address', '127.0.0.1')
    .option('--sync', 'pull and push local data on each refresh tick')
    .option('--no-sync', 'disable configured sync-on-refresh')
    .option('--dark', 'dark mode dashboard')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option('--all', 'single merged heatmap across all providers instead of one row per provider')
    .option('--year <year>', 'only include days from this calendar year', parsePositiveIntArgument)
    .action((options: DaemonOptions) => {
      runAsync(() => daemonCommand(options));
    });

  program
    .command('top [kind]')
    .description(
      'Show top items by tokens or cost. kind: "days" (default) or "models". Uses already-local synced machine data.',
    )
    .option('-n, --limit <n>', 'number of items to show', parseIntArgument, 10)
    .option('--sort <field>', 'sort by "tokens" or "cost"', 'cost')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option('--year <year>', 'only include days from this calendar year', parsePositiveIntArgument)
    .option(
      '--since <date>',
      'only include days on or after this date (YYYY-MM-DD)',
      parseDateOption,
    )
    .option(
      '--until <date>',
      'only include days on or before this date (YYYY-MM-DD)',
      parseDateOption,
    )
    .option(REFRESH_FLAG, REFRESH_DESC)
    .option('--json', 'print machine-readable JSON')
    .action((kind: string | undefined, options: TopCliOptions) => {
      runTop(kind, options);
    });

  program
    .command('machines')
    .description(
      'List all machines synced to the repo with totals, last sync, and active providers',
    )
    .option('--json', 'print machine-readable JSON')
    .action((options: { json?: boolean }) => {
      runAsync(() => machinesCommand({ json: options.json }));
    });

  program
    .command('recompute-costs')
    .description(
      'Refresh costs: re-read local JSONL on this machine; reprice other machines from stored cache breakdown',
    )
    .action(() => {
      runAsync(recomputeCostsCommand);
    });

  program
    .command('doctor')
    .description('Check local setup, provider sources, git sync health, and pricing metadata')
    .option('--pricing-check', 'run the pricing drift script from a source checkout')
    .option('--json', 'print machine-readable JSON')
    .action((options: { pricingCheck?: boolean; json?: boolean }) => {
      runAsync(() => doctorCommand({ pricingCheck: options.pricingCheck, json: options.json }));
    });

  const config = program
    .command('config')
    .description('Get, set, or list aitrack configuration (~/.config/aitrack/config.json)');

  config
    .command('list')
    .description('Print the current configuration')
    .action(() => {
      runAsync(() => configCommand({ action: 'list' }));
    });

  config
    .command('get <key>')
    .description('Print a single configuration value')
    .action((key: string) => {
      runAsync(() => configCommand({ action: 'get', key }));
    });

  config
    .command('set <key> <value>')
    .description(`Set a configuration value (keys: ${CONFIG_KEYS.join(', ')})`)
    .action((key: string, value: string) => {
      runAsync(() => configCommand({ action: 'set', key, value }));
    });

  return program;
}
