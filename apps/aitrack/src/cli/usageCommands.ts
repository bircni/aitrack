import { USAGE_PERIOD_DEFINITIONS } from 'aitrack-lib/data/usagePeriods';
import type { Command } from 'commander';

import { usageCommand } from '../commands/usage.js';
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

    command.action(() => {
      // Parsed inside runAsync so a bad argument exits like every other failure.
      runAsync(() => {
        const options = command.opts<UsageCommonOptions>();
        return usageCommand({
          ...parseUsageReportOptions({
            period: def.period,
            args: command.args,
            providers: options.providers,
          }),
          json: options.json,
          ...(options.compare !== undefined && { compare: options.compare }),
          ...(options.refresh !== undefined && { refreshLive: options.refresh }),
        });
      });
    });
  }
}

export { PROVIDERS_DESC, PROVIDERS_FLAG, REFRESH_DESC, REFRESH_FLAG };
