import { USAGE_PERIOD_DEFINITIONS } from 'aitrack-lib/data/usagePeriods';
import type { Command } from 'commander';

import { usageCommand, type UsageOptions } from '../commands/usage.js';
import { parseProviders, parseUsageReportOptions } from './parse.js';

interface UsageCommonOptions {
  providers?: string[];
  json?: boolean;
  compare?: boolean;
  refresh?: boolean;
}

const PROVIDERS_FLAG = '--providers <list>';
const PROVIDERS_DESC = 'comma-separated providers to show (claude, codex, cursor); default: all';
const REFRESH_FLAG = '--refresh';
const REFRESH_DESC = 're-fetch live provider data (Cursor), ignoring the local cache';

/**
 * Parsing happens inside the async body so a bad period travels through
 * `runAsync` like every other failure, instead of duplicating its catch-and-exit.
 */
function runUsageFromPeriod(
  period: string,
  args: string[],
  options: UsageCommonOptions,
  runAsync: (function_: () => Promise<void>) => void,
): void {
  runAsync(() => {
    const parsed: UsageOptions = {
      ...parseUsageReportOptions({ period, args, providers: options.providers }),
      json: options.json,
      ...(options.compare !== undefined && { compare: options.compare }),
      ...(options.refresh !== undefined && { refreshLive: options.refresh }),
    };
    return usageCommand(parsed);
  });
}

export function registerUsageCommands(
  usage: Command,
  runAsync: (function_: () => Promise<void>) => void,
): void {
  for (const def of USAGE_PERIOD_DEFINITIONS) {
    const command = usage
      .command(def.name)
      .description(def.description)
      .option(PROVIDERS_FLAG, PROVIDERS_DESC, parseProviders)
      .option(REFRESH_FLAG, REFRESH_DESC)
      .option('--compare', 'compare with the equivalent previous period')
      .option('--json', 'print machine-readable JSON');

    switch (def.argShape) {
      case 'date': {
        command.action((date: string, options: UsageCommonOptions) => {
          runUsageFromPeriod(def.period, [date], options, runAsync);
        });
        break;
      }
      case 'range': {
        command.action((from: string, to: string, options: UsageCommonOptions) => {
          runUsageFromPeriod(def.period, [from, to], options, runAsync);
        });
        break;
      }
      case 'last': {
        command.action((n: string, options: UsageCommonOptions) => {
          runUsageFromPeriod(def.period, [n], options, runAsync);
        });
        break;
      }
      case 'none': {
        command.action((options: UsageCommonOptions) => {
          runUsageFromPeriod(def.period, [], options, runAsync);
        });
        break;
      }
    }
  }
}

export { PROVIDERS_DESC, PROVIDERS_FLAG, REFRESH_DESC, REFRESH_FLAG };
