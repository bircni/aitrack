import type { MachineFile } from 'aitrack-lib/data/types';
import { describe, expect, it, vi } from 'vitest';

import { handleRequest, parseRequest } from '../protocol.js';
import { QuotaService } from '../service.js';
import { DEFAULT_SETTINGS } from '../settings.js';

function context() {
  const saved: unknown[] = [];
  const sync = vi.fn(() =>
    Promise.resolve({ message: 'synced', machine: { hostname: 'host' } as MachineFile }),
  );
  const service = new QuotaService(
    {
      fetchQuota: (provider) =>
        Promise.resolve({ ok: false, error: { kind: 'noCredentials', message: `no ${provider}` } }),
      loadUsage: () => Promise.resolve({ summary: { providers: {}, machineCount: 1 } }),
      now: () => 0,
      onState: () => undefined,
      onAlert: () => undefined,
      persist: () => undefined,
      sync,
    },
    DEFAULT_SETTINGS,
  );
  return {
    saved,
    sync,
    handler: {
      service,
      settings: () => DEFAULT_SETTINGS,
      saveSettings: (settings: typeof DEFAULT_SETTINGS) => {
        saved.push(settings);
        return Promise.resolve(settings);
      },
    },
  };
}

describe('sidecar protocol', () => {
  it('parses requests and rejects anything else', () => {
    expect(parseRequest('{"id":1,"method":"getState"}')).toEqual({
      id: 1,
      method: 'getState',
      params: undefined,
    });
    expect(parseRequest('{"id":"1","method":"getState"}')).toBeUndefined();
    expect(parseRequest('null')).toBeUndefined();
    expect(parseRequest('{')).toBeUndefined();
  });

  it('answers every method with its id', async () => {
    const { handler, saved, sync } = context();
    const state = await handleRequest({ id: 1, method: 'getState' }, handler);
    expect(state).toMatchObject({
      id: 1,
      result: { providers: [{ key: 'claude_code' }, { key: 'codex' }, { key: 'cursor' }] },
    });

    expect(await handleRequest({ id: 2, method: 'refresh' }, handler)).toEqual({
      id: 2,
      result: null,
    });
    await vi.waitFor(() => {
      expect(handler.service.state().providers[0]?.quotaError?.kind).toBe('noCredentials');
    });

    expect(await handleRequest({ id: 3, method: 'getSettings' }, handler)).toEqual({
      id: 3,
      result: DEFAULT_SETTINGS,
    });
    await handleRequest({ id: 4, method: 'saveSettings', params: { theme: 'dark' } }, handler);
    expect(saved).toEqual([{ ...DEFAULT_SETTINGS, theme: 'dark' }]);

    expect(await handleRequest({ id: 5, method: 'sync' }, handler)).toEqual({
      id: 5,
      result: null,
    });
    await vi.waitFor(() => {
      expect(sync).toHaveBeenCalledOnce();
      expect(handler.service.state().syncResult).toEqual({ ok: true, message: 'synced' });
    });
  });

  it('turns failures into error responses', async () => {
    const { handler } = context();
    expect(await handleRequest({ id: 9, method: 'nope' }, handler)).toEqual({
      id: 9,
      error: 'Unknown method nope',
    });
  });
});
