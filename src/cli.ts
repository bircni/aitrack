#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { program } from 'commander';
import { syncCommand } from './sync.js';
import { showCommand } from './show.js';
import { initCommand } from './init.js';
import { recomputeCostsCommand } from './recompute.js';
import { summaryCommand } from './summary.js';
import { todayCommand } from './today.js';
import { tuiCommand } from './tui.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
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
  .description('Pull data from all machines and render heatmap PNG')
  .option('-o, --output <path>', 'output file path', 'aitrack.png')
  .option('--dark', 'dark mode output')
  .option('--no-cursor', 'skip local Cursor usage (no state.vscdb / CSV export)')
  .option('--all', 'single merged heatmap across all providers instead of one row per provider')
  .option('--no-open', 'do not auto-open the generated PNG (useful for scripts / CI)')
  .option('--year <year>', 'only include days from this calendar year', parseInt)
  .action(
    (opts: {
      output: string;
      dark?: boolean;
      cursor?: boolean;
      all?: boolean;
      open?: boolean;
      year?: number;
    }) =>
      showCommand({
        output: opts.output,
        dark: opts.dark,
        all: opts.all,
        open: opts.open,
        noCursor: opts.cursor === false,
        year: Number.isFinite(opts.year) ? opts.year : undefined,
      }).catch((err: unknown) => {
        console.error(errorMessage(err));
        process.exit(1);
      }),
  );

program
  .command('tui')
  .description('Display usage stats table in the terminal (no PNG)')
  .option('--dark', 'high-contrast table colors')
  .option('--no-cursor', 'skip local Cursor usage')
  .option('--all', 'single merged stats row across all providers')
  .option('--year <year>', 'only include days from this calendar year', parseInt)
  .action((opts: { dark?: boolean; cursor?: boolean; all?: boolean; year?: number }) =>
    tuiCommand({
      dark: opts.dark,
      all: opts.all,
      noCursor: opts.cursor === false,
      year: Number.isFinite(opts.year) ? opts.year : undefined,
    }).catch((err: unknown) => {
      console.error(errorMessage(err));
      process.exit(1);
    }),
  );

program
  .command('summary')
  .description('Print per-provider monthly token + cost totals to stdout (no PNG)')
  .option('--no-cursor', 'skip local Cursor usage')
  .option('--year <year>', 'only include days from this calendar year', parseInt)
  .action((opts: { cursor?: boolean; year?: number }) =>
    summaryCommand({
      noCursor: opts.cursor === false,
      year: Number.isFinite(opts.year) ? opts.year : undefined,
    }).catch((err: unknown) => {
      console.error(errorMessage(err));
      process.exit(1);
    }),
  );

program
  .command('today')
  .description("Show today's usage: provider / tokens / model / price")
  .option('--no-cursor', 'skip local Cursor usage')
  .action((opts: { cursor?: boolean }) =>
    todayCommand({ noCursor: opts.cursor === false }).catch((err: unknown) => {
      console.error(errorMessage(err));
      process.exit(1);
    }),
  );

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
