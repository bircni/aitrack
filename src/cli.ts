#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { program } from 'commander';
import { syncCommand } from './sync.js';
import { showCommand } from './show.js';
import { initCommand } from './init.js';
import { recomputeCostsCommand } from './recompute.js';
import { usageCommand, type UsageOptions } from './usage.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function runUsage(opts: UsageOptions): void {
  usageCommand(opts).catch((err: unknown) => {
    console.error(errorMessage(err));
    process.exit(1);
  });
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Invalid date: "${date}". Expected YYYY-MM-DD.`);
    process.exit(1);
  }
}

program
  .name('aitrack')
  .description('Sync AI coding assistant usage across machines via GitHub')
  .version(packageVersion());

program
  .command('init')
  .description('Interactive setup: configure git remote and clone repo')
  .action(() =>
    initCommand().catch((err: unknown) => {
      console.error(errorMessage(err));
      process.exit(1);
    }),
  );

program
  .command('sync')
  .description('Read local AI usage data and push to git repo')
  .action(() =>
    syncCommand().catch((err: unknown) => {
      console.error(errorMessage(err));
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
      }).catch((err: unknown) => {
        console.error(errorMessage(err));
        process.exit(1);
      }),
  );

const usage = program
  .command('usage')
  .description('Show usage broken down by provider and model over a fixed time window');

usage
  .command('today')
  .description("Today's usage: provider / tokens / model / price")
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'today', noCursor: opts.cursor === false });
  });

usage
  .command('yesterday')
  .description("Yesterday's usage")
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'yesterday', noCursor: opts.cursor === false });
  });

usage
  .command('date <date>')
  .description('Usage for a specific date (YYYY-MM-DD)')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((date: string, opts: { cursor?: boolean }) => {
    validateDate(date);
    runUsage({ period: 'date', from: date, noCursor: opts.cursor === false });
  });

usage
  .command('range <from> <to>')
  .description('Usage for a custom date range (YYYY-MM-DD YYYY-MM-DD)')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((from: string, to: string, opts: { cursor?: boolean }) => {
    validateDate(from);
    validateDate(to);
    if (from > to) {
      console.error(`Start date "${from}" must not be after end date "${to}".`);
      process.exit(1);
    }
    runUsage({ period: 'range', from, to, noCursor: opts.cursor === false });
  });

usage
  .command('thisweek')
  .description('Usage for the current calendar week (Mon–Sun)')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'thisweek', noCursor: opts.cursor === false });
  });

usage
  .command('lastweek')
  .description('Usage for the previous calendar week (Mon–Sun)')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'lastweek', noCursor: opts.cursor === false });
  });

usage
  .command('week')
  .description('Rolling 7-day usage ending today')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'week', noCursor: opts.cursor === false });
  });

usage
  .command('thismonth')
  .description('Usage for the current calendar month')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'thismonth', noCursor: opts.cursor === false });
  });

usage
  .command('lastmonth')
  .description('Usage for the previous calendar month')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'lastmonth', noCursor: opts.cursor === false });
  });

usage
  .command('month')
  .description('Rolling 30-day usage ending today')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'month', noCursor: opts.cursor === false });
  });

usage
  .command('last <n>')
  .description('Rolling N-day usage ending today, e.g. last 14')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((n: string, opts: { cursor?: boolean }) => {
    const days = parseInt(n, 10);
    if (!Number.isInteger(days) || days < 1) {
      console.error(`Invalid number of days: "${n}". Expected a positive integer.`);
      process.exit(1);
    }
    runUsage({ period: 'last', n: days, noCursor: opts.cursor === false });
  });

usage
  .command('year')
  .description('Usage for the current calendar year')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'year', noCursor: opts.cursor === false });
  });

usage
  .command('all')
  .description('All-time usage across every recorded day')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage({ period: 'all', noCursor: opts.cursor === false });
  });

program
  .command('recompute-costs')
  .description(
    'Refresh costs: re-read local JSONL on this machine; reprice other machines from stored cache breakdown',
  )
  .action(() =>
    recomputeCostsCommand().catch((err: unknown) => {
      console.error(errorMessage(err));
      process.exit(1);
    }),
  );

program.parse();
