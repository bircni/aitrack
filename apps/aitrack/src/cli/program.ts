import { errorMessage } from 'aitrack-lib/errors';
import { log } from 'aitrack-lib/output';
import { recomputeCosts } from 'aitrack-lib/recompute';
import { Argument, Command, Option } from 'commander';

import { CONFIG_KEYS, configCommand } from '../commands/config.js';
import { doctorCommand } from '../commands/doctor.js';
import type { ExportOptions } from '../commands/export.js';
import { initCommand } from '../commands/init.js';
import { installOpentrackCommand } from '../commands/installOpentrack.js';
import { machinesCommand } from '../commands/machines.js';
import type { ShowOptions } from '../commands/show.js';
import { syncCommand } from '../commands/sync.js';
import { topCommand, type TopKind, type TopOptions } from '../commands/top.js';
import { cliVersion } from '../version.js';
import {
  parseDateOption,
  parsePositiveIntArgument,
  parseProviders,
  parseYearArgument,
} from './parse.js';
import {
  PROVIDERS_DESC,
  PROVIDERS_FLAG,
  REFRESH_DESC,
  REFRESH_FLAG,
  registerUsageCommands,
} from './usageCommands.js';

/** Prints a rejection (or a synchronous throw) and sets a failing exit code. */
export function runAsync(function_: () => Promise<void>): void {
  try {
    function_().catch(fail);
  } catch (error) {
    fail(error);
  }
}

function fail(error: unknown): void {
  log.error(errorMessage(error));
  process.exitCode = 1; // Not process.exit, which can truncate buffered stdout.
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
    .option('--year <year>', 'only include days from this calendar year', parseYearArgument)
    .option(REFRESH_FLAG, REFRESH_DESC)
    .option('--tui', 'render a stats table in the terminal instead of a PNG')
    .action((options: ShowOptions) => {
      runAsync(async () => {
        const { showCommand } = await import('../commands/show.js'); // Keeps the native canvas binding off other commands' startup.
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
    .option('-o, --output <path>', 'output path (default: aitrack-receipt.pdf, or .csv with --csv)')
    .option('--csv', 'write a spreadsheet-friendly CSV instead of the PDF receipt')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option(REFRESH_FLAG, REFRESH_DESC)
    .action((period: string | undefined, args: string[], options: ExportOptions) => {
      runAsync(async () => {
        const { exportCommand } = await import('../commands/export.js'); // Keeps pdfkit off other commands' startup.
        await exportCommand({ ...options, period, args });
      });
    });

  program
    .command('top')
    .description(
      'Show top days or models by tokens or cost. Uses already-local synced machine data.',
    )
    .addArgument(new Argument('[kind]', 'what to rank').choices(['days', 'models']).default('days'))
    .option('-n, --limit <n>', 'number of items to show', parsePositiveIntArgument, 10)
    .addOption(
      new Option('--sort <field>', 'sort field').choices(['tokens', 'cost']).default('cost'),
    )
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option('--year <year>', 'only include days from this calendar year', parseYearArgument)
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
    .action((kind: TopKind, options: Omit<TopOptions, 'kind'>) => {
      runAsync(() => topCommand({ ...options, kind }));
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
    .option(
      '--replace-local',
      'Rebuild this machine from the local logs, dropping synced days the logs no longer cover',
    )
    .action((options: { replaceLocal?: boolean }) => {
      runAsync(() => recomputeCosts({ replaceLocal: options.replaceLocal }));
    });

  program
    .command('doctor')
    .description('Check local setup, provider sources, git sync health, and pricing metadata')
    .option('--pricing-check', 'run the pricing drift script from a source checkout')
    .option('--json', 'print machine-readable JSON')
    .action((options: { pricingCheck?: boolean; json?: boolean }) => {
      runAsync(() => doctorCommand({ pricingCheck: options.pricingCheck, json: options.json }));
    });

  program
    .command('install-opentrack')
    .description('Install the opentrack desktop app from the latest GitHub release')
    .option('--dir <path>', 'macOS: folder to put opentrack.app in (default: /Applications)')
    .action((options: { dir?: string }) => {
      runAsync(() => installOpentrackCommand({ dir: options.dir }));
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
