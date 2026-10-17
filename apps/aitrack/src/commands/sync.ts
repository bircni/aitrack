import { syncData } from 'aitrack-lib/sync';

import { printJsonCommand } from '../cli/json.js';

export interface SyncOptions {
  dryRun?: boolean;
  verify?: boolean;
  json?: boolean;
}

export async function syncCommand(options: SyncOptions): Promise<void> {
  const { message, pushed, days } = await syncData({
    dryRun: options.dryRun,
    verify: options.verify,
  });
  if (options.json) {
    printJsonCommand('sync', { message, pushed, days, dryRun: Boolean(options.dryRun) });
  }
}
