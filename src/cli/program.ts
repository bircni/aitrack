import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { configCommand } from '../commands/config.js';
import { daemonCommand } from '../commands/daemon.js';
import { exportCommand } from '../commands/export.js';
import { initCommand } from '../commands/init.js';
import { machinesCommand } from '../commands/machines.js';
import { recomputeCostsCommand } from '../commands/recompute.js';
import { showCommand } from '../commands/show.js';
import { syncCommand } from '../commands/sync.js';
import { topCommand } from '../commands/top.js';
import { usageCommand, type UsageOptions } from '../commands/usage.js';
import { type UsagePeriod } from '../display/usagePeriods.js';
import {
  cliErrorMessage,
  dateRangeValidationError,
  invalidDateMessage,
  isValidDateString,
  parseIntArg as parseIntArgument,
  parsePositiveInt,
  parseProviders,
  parseTopKind,
  parseTopSort,
  topKindValidationError,
  topLimitValidationError,
  topSortValidationError,
  usageLastDaysValidationError,
} from './parse.js';

/**
 * Run an async command handler, printing a friendly error and exiting with a
 * non-zero status if it rejects. Centralises the catch/exit boilerplate shared
 * by every CLI action.
 */
export function runAsync(function_: () => Promise<void>): void {
  function_().catch((error: unknown) => {
    console.error(cliErrorMessage(error));
    process.exit(1);
  });
}

function packageVersion(): string {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string' &&
      parsed.version.length > 0
    ) {
      return parsed.version;
    }
  } catch {
    // fall through to the placeholder below
  }
  return '0.0.0';
}

function runUsage(options: UsageOptions): void {
  runAsync(() => usageCommand(options));
}

function validateDate(date: string): void {
  if (isValidDateString(date)) {
    return;
  }

  console.error(invalidDateMessage(date));
  process.exit(1);
}

interface UsageCommonOptions {
  providers?: string[];
}

const PROVIDERS_FLAG = '--providers <list>';
const PROVIDERS_DESC = 'comma-separated providers to show (claude, codex, cursor); default: all';

type UsagePeriodDef =
  | { name: string; period: UsagePeriod; description: string }
  | { name: string; period: 'date'; description: string; arg: 'date' }
  | { name: string; period: 'range'; description: string; args: ['from', 'to'] }
  | { name: string; period: 'last'; description: string; arg: 'n' };

const USAGE_PERIODS: UsagePeriodDef[] = [
  {
    name: 'today',
    period: 'today',
    description: "Today's usage: provider / tokens / model / price",
  },
  { name: 'yesterday', period: 'yesterday', description: "Yesterday's usage" },
  {
    name: 'date <date>',
    period: 'date',
    description: 'Usage for a specific date (YYYY-MM-DD)',
    arg: 'date',
  },
  {
    name: 'range <from> <to>',
    period: 'range',
    description: 'Usage for a custom date range (YYYY-MM-DD YYYY-MM-DD)',
    args: ['from', 'to'],
  },
  {
    name: 'thisweek',
    period: 'thisweek',
    description: 'Usage for the current calendar week (Mon–Sun)',
  },
  {
    name: 'lastweek',
    period: 'lastweek',
    description: 'Usage for the previous calendar week (Mon–Sun)',
  },
  { name: 'week', period: 'week', description: 'Rolling 7-day usage ending today' },
  { name: 'thismonth', period: 'thismonth', description: 'Usage for the current calendar month' },
  { name: 'lastmonth', period: 'lastmonth', description: 'Usage for the previous calendar month' },
  { name: 'month', period: 'month', description: 'Rolling 30-day usage ending today' },
  {
    name: 'last <n>',
    period: 'last',
    description: 'Rolling N-day usage ending today, e.g. last 14',
    arg: 'n',
  },
  { name: 'year', period: 'year', description: 'Usage for the current calendar year' },
  { name: 'all', period: 'all', description: 'All-time usage across every recorded day' },
];

function registerUsageCommands(usage: Command): void {
  for (const def of USAGE_PERIODS) {
    const command = usage
      .command(def.name)
      .description(def.description)
      .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders);

    if (def.period === 'date') {
      command.action((date: string, options: UsageCommonOptions) => {
        validateDate(date);
        runUsage({ period: 'date', from: date, providers: options.providers });
      });
      continue;
    }

    if (def.period === 'range') {
      command.action((from: string, to: string, options: UsageCommonOptions) => {
        validateDate(from);
        validateDate(to);
        const rangeError = dateRangeValidationError(from, to);
        if (rangeError) {
          console.error(rangeError);
          process.exit(1);
        }
        runUsage({ period: 'range', from, to, providers: options.providers });
      });
      continue;
    }

    if (def.period === 'last') {
      command.action((n: string, options: UsageCommonOptions) => {
        const lastError = usageLastDaysValidationError(n);
        if (lastError) {
          console.error(lastError);
          process.exit(1);
        }
        runUsage({
          period: 'last',
          n: parsePositiveInt(n) ?? 1,
          providers: options.providers,
        });
      });
      continue;
    }

    command.action((options: UsageCommonOptions) => {
      runUsage({ period: def.period, providers: options.providers });
    });
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('aitrack')
    .description('Sync AI coding assistant usage across machines via GitHub')
    .version(packageVersion());

  program
    .command('init')
    .description('Interactive setup: configure git remote and clone repo')
    .action(() => {
      runAsync(initCommand);
    });

  program
    .command('sync')
    .description('Read local AI usage data and push to git repo')
    .action(() => {
      runAsync(syncCommand);
    });

  program
    .command('show')
    .description(
      'Pull data from all machines and render heatmap PNG (or terminal table with --tui)',
    )
    .option('-o, --output <path>', 'output file path', 'aitrack.png')
    .option('--dark', 'dark mode output')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option('--all', 'single merged heatmap across all providers instead of one row per provider')
    .option('--no-open', 'do not auto-open the generated PNG (useful for scripts / CI)')
    .option('--year <year>', 'only include days from this calendar year', parseInt)
    .option('--tui', 'render a stats table in the terminal instead of a PNG')
    .action(
      (options: {
        output: string;
        dark?: boolean;
        providers?: string[];
        all?: boolean;
        open?: boolean;
        year?: number;
        tui?: boolean;
      }) => {
        runAsync(() =>
          showCommand({
            output: options.output,
            dark: options.dark,
            all: options.all,
            open: options.open,
            providers: options.providers,
            year: Number.isFinite(options.year) ? options.year : undefined,
            tui: options.tui,
          }),
        );
      },
    );

  const usage = program
    .command('usage')
    .description('Show usage broken down by provider and model over a fixed time window');
  registerUsageCommands(usage);

  program
    .command('export [period]')
    .description('Export an itemized PDF usage receipt for a period (default: month)')
    .option('-o, --output <path>', 'output PDF path', 'aitrack-receipt.pdf')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .action((period: string | undefined, options: { output: string; providers?: string[] }) => {
      runAsync(() =>
        exportCommand({
          period,
          output: options.output,
          providers: options.providers,
        }),
      );
    });

  program
    .command('daemon')
    .description('Run a local HTTP dashboard that refreshes usage data on an interval')
    .option('--port <port>', 'HTTP listen port', parseIntArgument)
    .option('--interval <seconds>', 'seconds between data refresh ticks', parseIntArgument)
    .option('--host <host>', 'bind address', '127.0.0.1')
    .option('--sync', 'pull and push local data on each refresh tick')
    .option('--dark', 'dark mode dashboard')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option('--all', 'single merged heatmap across all providers instead of one row per provider')
    .option('--year <year>', 'only include days from this calendar year', parseIntArgument)
    .action(
      (options: {
        port?: number;
        interval?: number;
        host?: string;
        sync?: boolean;
        dark?: boolean;
        providers?: string[];
        all?: boolean;
        year?: number;
      }) => {
        runAsync(() =>
          daemonCommand({
            port: options.port,
            interval: options.interval,
            host: options.host,
            sync: options.sync,
            dark: options.dark,
            all: options.all,
            providers: options.providers,
            year: options.year,
          }),
        );
      },
    );

  program
    .command('top [kind]')
    .description(
      'Show top items by tokens or cost. kind: "days" (default) or "models". Uses already-local synced machine data.',
    )
    .option('-n, --limit <n>', 'number of items to show', parseIntArgument, 10)
    .option('--sort <field>', 'sort by "tokens" or "cost"', 'cost')
    .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
    .option('--year <year>', 'only include days from this calendar year', parseIntArgument)
    .action(
      (
        kind: string | undefined,
        options: {
          limit: number;
          sort: string;
          providers?: string[];
          year?: number;
        },
      ) => {
        const kindError = topKindValidationError(kind);
        if (kindError) {
          console.error(kindError);
          process.exit(1);
        }
        const sortError = topSortValidationError(options.sort);
        if (sortError) {
          console.error(sortError);
          process.exit(1);
        }
        const limitError = topLimitValidationError(options.limit);
        if (limitError) {
          console.error(limitError);
          process.exit(1);
        }
        runAsync(() =>
          topCommand({
            kind: parseTopKind(kind),
            limit: options.limit,
            sort: parseTopSort(options.sort),
            providers: options.providers,
            year: options.year,
          }),
        );
      },
    );

  program
    .command('machines')
    .description(
      'List all machines synced to the repo with totals, last sync, and active providers',
    )
    .action(() => {
      runAsync(machinesCommand);
    });

  program
    .command('recompute-costs')
    .description(
      'Refresh costs: re-read local JSONL on this machine; reprice other machines from stored cache breakdown',
    )
    .action(() => {
      runAsync(recomputeCostsCommand);
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
    .description('Set a configuration value (keys: repoUrl, machineId)')
    .action((key: string, value: string) => {
      runAsync(() => configCommand({ action: 'set', key, value }));
    });

  return program;
}
