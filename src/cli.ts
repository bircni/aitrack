#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { program } from 'commander';
import { syncCommand } from './sync.js';
import { showCommand } from './show.js';
import { initCommand } from './init.js';
import { recomputeCostsCommand } from './recompute.js';
import { usageCommand, type UsagePeriod } from './usage.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function runUsage(period: UsagePeriod, opts: { cursor?: boolean }): void {
  usageCommand({ period, noCursor: opts.cursor === false }).catch((err: unknown) => {
    console.error(errorMessage(err));
    process.exit(1);
  });
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
    runUsage('today', opts);
  });

usage
  .command('week')
  .description('Rolling 7-day usage ending today')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage('week', opts);
  });

usage
  .command('month')
  .description('Rolling 30-day usage ending today')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage('month', opts);
  });

usage
  .command('year')
  .description('Usage for the current calendar year')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage('year', opts);
  });

usage
  .command('all')
  .description('All-time usage across every recorded day')
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) => {
    runUsage('all', opts);
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
