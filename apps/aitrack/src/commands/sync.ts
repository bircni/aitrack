import { type SyncDataOptions, syncData } from 'aitrack-lib/sync';

export async function syncCommand(options: SyncDataOptions = {}): Promise<void> {
  await syncData(options);
}
