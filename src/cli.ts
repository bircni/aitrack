#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { program } from 'commander';

import { daemonCommand } from './commands/daemon.js';
import { initCommand } from './commands/init.js';
import { machinesCommand } from './commands/machines.js';
import { recomputeCostsCommand } from './commands/recompute.js';
import { showCommand } from './commands/show.js';
import { syncCommand } from './commands/sync.js';
import { topCommand, type TopKind } from './commands/top.js';
import { usageCommand, type UsageOptions } from './commands/usage.js';
import { type UsagePeriod } from './display/usagePeriods.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function runUsage(opts: UsageOptions): void {
  usageCommand(opts).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Invalid date: "${date}". Expected YYYY-MM-DD.`);
    process.exit(1);
  }
}

const parseIntArg = (value: string): number => {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`Expected an integer, got: ${value}`);
  return n;
};

program
  .name('aitrack')
  .description('Sync AI coding assistant usage across machines via GitHub')
  .version(packageVersion());

program
  .command('init')
  .description('Interactive setup: configure git remote and clone repo')
  .action(() =>
    initCommand().catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    }),
  );

program
  .command('sync')
  .description('Read local AI usage data and push to git repo')
  .action(() =>
    syncCommand().catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    }),
  );

program
  .command('show')
  .description('Pull data from all machines and render heatmap PNG (or terminal table with --tui)')
  .option('-o, --output <path>', 'output file path', 'aitrack.png')
  .option('--dark', 'dark mode output')
  .option('--no-cursor', 'skip local Cursor usage (no state.vscdb / CSV export)')
  .option('--all', 'single merged heatmap across all providers instead of one row per provider')
  .option('--no-open', 'do not auto-open the generated PNG (useful for scripts / CI)')
  .option('--year <year>', 'only include days from this calendar year', parseInt)
  .option('--tui', 'render a stats table in the terminal instead of a PNG')
  .action(
    (opts: {
      output: string;
      dark?: boolean;
      cursor?: boolean;
      all?: boolean;
      open?: boolean;
      year?: number;
      tui?: boolean;
    }) =>
      showCommand({
        output: opts.output,
        dark: opts.dark,
        all: opts.all,
        open: opts.open,
        noCursor: opts.cursor === false,
        year: Number.isFinite(opts.year) ? opts.year : undefined,
        tui: opts.tui,
      }).catch((error: unknown) => {
        console.error(errorMessage(error));
        process.exit(1);
      }),
  );

const usage = program
  .command('usage')
  .description('Show usage broken down by provider and model over a fixed time window');

interface UsageCommonOpts {
  cursor?: boolean;
}

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

for (const def of USAGE_PERIODS) {
  const cmd = usage
    .command(def.name)
    .description(def.description)
    .option('--no-cursor', 'skip local Cursor usage');

  if (def.period === 'date') {
    cmd.action((date: string, opts: UsageCommonOpts) => {
      validateDate(date);
      runUsage({ period: 'date', from: date, noCursor: opts.cursor === false });
    });
    continue;
  }

  if (def.period === 'range') {
    cmd.action((from: string, to: string, opts: UsageCommonOpts) => {
      validateDate(from);
      validateDate(to);
      if (from > to) {
        console.error(`Start date "${from}" must not be after end date "${to}".`);
        process.exit(1);
      }
      runUsage({ period: 'range', from, to, noCursor: opts.cursor === false });
    });
    continue;
  }

  if (def.period === 'last') {
    cmd.action((n: string, opts: UsageCommonOpts) => {
      const days = parseInt(n, 10);
      if (!Number.isInteger(days) || days < 1) {
        console.error(`Invalid number of days: "${n}". Expected a positive integer.`);
        process.exit(1);
      }
      runUsage({ period: 'last', n: days, noCursor: opts.cursor === false });
    });
    continue;
  }

  cmd.action((opts: UsageCommonOpts) => {
    runUsage({ period: def.period, noCursor: opts.cursor === false });
  });
}

program
  .command('daemon')
  .description('Run a local HTTP dashboard that refreshes usage data on an interval')
  .option('--port <port>', 'HTTP listen port', parseIntArg)
  .option('--interval <seconds>', 'seconds between data refresh ticks', parseIntArg)
  .option('--host <host>', 'bind address', '127.0.0.1')
  .option('--sync', 'pull and push local data on each refresh tick')
  .option('--no-sync', 'only pull remote data on each refresh tick')
  .option('--dark', 'dark mode dashboard')
  .option('--no-cursor', 'skip local Cursor usage (no state.vscdb / CSV export)')
  .option('--all', 'single merged heatmap across all providers instead of one row per provider')
  .option('--year <year>', 'only include days from this calendar year', parseIntArg)
  .action(
    (opts: {
      port?: number;
      interval?: number;
      host?: string;
      sync?: boolean;
      dark?: boolean;
      cursor?: boolean;
      all?: boolean;
      year?: number;
    }) => {
      // Commander collapses --sync/--no-sync into a single opts.sync tri-state
      // (true | false | undefined). undefined means "fall back to config default".
      daemonCommand({
        port: opts.port,
        interval: opts.interval,
        host: opts.host,
        sync: opts.sync,
        dark: opts.dark,
        all: opts.all,
        noCursor: opts.cursor === false,
        year: opts.year,
      }).catch((error: unknown) => {
        console.error(errorMessage(error));
        process.exit(1);
      });
    },
  );

program
  .command('top [kind]')
  .description(
    'Show top items by tokens or cost. kind: "days" (default) or "models". Pulls from all configured machines.',
  )
  .option('-n, --limit <n>', 'number of items to show', parseIntArg, 10)
  .option('--sort <field>', 'sort by "tokens" or "cost"', 'cost')
  .option('--no-cursor', 'skip local Cursor usage')
  .option('--year <year>', 'only include days from this calendar year', parseIntArg)
  .action(
    (
      kind: string | undefined,
      opts: {
        limit: number;
        sort: string;
        cursor?: boolean;
        year?: number;
      },
    ) => {
      const k: TopKind = kind === 'models' ? 'models' : 'days';
      if (kind !== undefined && kind !== 'days' && kind !== 'models') {
        console.error(`Invalid kind: "${kind}". Expected "days" or "models".`);
        process.exit(1);
      }
      if (opts.sort !== 'tokens' && opts.sort !== 'cost') {
        console.error(`Invalid --sort value: "${opts.sort}". Expected "tokens" or "cost".`);
        process.exit(1);
      }
      const sort = opts.sort;
      if (!Number.isInteger(opts.limit) || opts.limit < 1) {
        console.error(`Invalid --limit: "${String(opts.limit)}". Expected a positive integer.`);
        process.exit(1);
      }
      topCommand({
        kind: k,
        limit: opts.limit,
        sort,
        noCursor: opts.cursor === false,
        year: opts.year,
      }).catch((error: unknown) => {
        console.error(errorMessage(error));
        process.exit(1);
      });
    },
  );

program
  .command('machines')
  .description('List all machines synced to the repo with totals, last sync, and active providers')
  .action(() =>
    machinesCommand().catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    }),
  );

program
  .command('recompute-costs')
  .description(
    'Refresh costs: re-read local JSONL on this machine; reprice other machines from stored cache breakdown',
  )
  .action(() =>
    recomputeCostsCommand().catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    }),
  );

program.parse();
