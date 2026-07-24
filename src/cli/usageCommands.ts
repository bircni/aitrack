import type { Command } from 'commander';

import { usageCommand, type UsageOptions } from '../commands/usage.js';
import { USAGE_PERIOD_DEFINITIONS } from '../display/usagePeriods.js';
import { cliErrorMessage, parseProviders, parseUsageReportOptions } from './parse.js';

interface UsageCommonOptions {
  providers?: string[];
  json?: boolean;
  compare?: boolean;
}

const PROVIDERS_FLAG = '--providers <list>';
const PROVIDERS_DESC = 'comma-separated providers to show (claude, codex, cursor); default: all';

function runUsageFromPeriod(
  period: string,
  args: string[],
  options: UsageCommonOptions,
  runAsync: (function_: () => Promise<void>) => void,
): void {
  let parsed: UsageOptions;
  try {
    parsed = {
      ...parseUsageReportOptions({ period, args, providers: options.providers }),
      json: options.json,
      ...(options.compare !== undefined && { compare: options.compare }),
    };
  } catch (error) {
    console.error(cliErrorMessage(error));
    process.exit(1);
    return;
  }
  runAsync(() => usageCommand(parsed));
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
      .option('--compare', 'compare with the equivalent previous period')
      .option('--json', 'print machine-readable JSON');

    switch (def.argShape) {
      case 'date':
        command.action((date: string, options: UsageCommonOptions) => {
          runUsageFromPeriod(def.period, [date], options, runAsync);
        });
        break;
      case 'range':
        command.action((from: string, to: string, options: UsageCommonOptions) => {
          runUsageFromPeriod(def.period, [from, to], options, runAsync);
        });
        break;
      case 'last':
        command.action((n: string, options: UsageCommonOptions) => {
          runUsageFromPeriod(def.period, [n], options, runAsync);
        });
        break;
      case 'none':
        command.action((options: UsageCommonOptions) => {
          runUsageFromPeriod(def.period, [], options, runAsync);
        });
        break;
    }
  }
}

export { PROVIDERS_DESC, PROVIDERS_FLAG };
