import { loggedOutput } from '@aitrack/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ syncData: vi.fn() }));
vi.mock('aitrack-lib/sync', () => ({ syncData: mocks.syncData }));

import { syncCommand } from '../sync.js';

describe('syncCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the outcome as one JSON document with --json', async () => {
    mocks.syncData.mockResolvedValue({ message: 'Done!', pushed: true, days: 4, machine: {} });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await syncCommand({ dryRun: true, json: true });
    expect(mocks.syncData).toHaveBeenCalledWith({ dryRun: true, verify: undefined });
    expect(JSON.parse(loggedOutput())).toEqual({
      command: 'sync',
      message: 'Done!',
      pushed: true,
      days: 4,
      dryRun: true,
    });
  });

  it('prints nothing itself without --json', async () => {
    mocks.syncData.mockResolvedValue({ message: 'Done!', pushed: false, days: 0, machine: {} });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await syncCommand({});
    expect(log).not.toHaveBeenCalled();
  });
});
