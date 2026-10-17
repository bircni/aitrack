import { USAGE_PERIOD_DEFINITIONS } from 'aitrack-lib/data/usagePeriods';
import type { Command } from 'commander';

import { usageCommand } from '../commands/usage.js';
import { UsageError } from './errors.js';
import { parseProviders, parseUsageReportOptions } from './parse.js';
import type { JsonRun } from './program.js';
import { parseWatchSeconds, watchUntilInterrupted } from './watch.js';

interface UsageCommonOptions {
  providers?: string[];
  json?: boolean;
  compare?: boolean;
  short?: boolean;
  refresh?: boolean;
  watch?: number | true;
}

const PROVIDERS_FLAG = '--providers <list>';
const PROVIDERS_DESC = 'comma-separated providers to show (claude, codex, cursor); default: all';
const REFRESH_FLAG = '--refresh';
const REFRESH_DESC = 're-fetch live provider data (Cursor), ignoring the local cache';

export function registerUsageCommands(
  usage: Command,
  runAsync: (function_: () => void | Promise<void>, json?: JsonRun) => void,
): void {
  for (const def of USAGE_PERIOD_DEFINITIONS) {
    const command = usage
      .command(def.name)
      .description(def.description)
      .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
      .option(REFRESH_FLAG, REFRESH_DESC)
      .option('--compare', 'compare with the equivalent previous period')
      .option('--short', 'print a single line (cost · tokens) for status bars and prompts')
      .option('--json', 'print machine-readable JSON')
      .option(
        '--watch [seconds]',
        'redraw in place every N seconds (default 30, minimum 5); needs a terminal',
        parseWatchSeconds,
      );

    command.action(() => {
      const options = command.opts<UsageCommonOptions>();
      // Parsed inside runAsync so a bad argument exits like every other failure.
      runAsync(
        () => {
          if (options.watch !== undefined && options.json) {
            throw new UsageError('--watch cannot be combined with --json.');
          }
          const run = (): Promise<void> =>
            usageCommand({
              ...parseUsageReportOptions({
                period: def.period,
                args: command.args,
                providers: options.providers,
              }),
              json: options.json,
              ...(options.short !== undefined && { short: options.short }),
              ...(options.compare !== undefined && { compare: options.compare }),
              ...(options.refresh !== undefined && { refreshLive: options.refresh }),
            });
          return options.watch === undefined ? run() : watchUntilInterrupted(run, options.watch);
        },
        { command: 'usage', enabled: options.json },
      );
    });
  }
}

export { PROVIDERS_DESC, PROVIDERS_FLAG, REFRESH_DESC, REFRESH_FLAG };
