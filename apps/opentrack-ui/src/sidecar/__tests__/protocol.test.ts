import { describe, expect, it, vi } from 'vitest';

import type { AppState } from '../../shared/types.js';
import { type HandlerContext, handleRequest, parseRequest } from '../protocol.js';
import { DEFAULT_SETTINGS } from '../settings.js';

function context() {
  const saved: unknown[] = [];
  const state: AppState = { providers: [], refreshing: false, machineCount: 1, syncing: false };
  const service = {
    state: () => state,
    refresh: vi.fn(() => Promise.resolve()),
    sync: vi.fn(() => Promise.resolve()),
  };
  const handler: HandlerContext = {
    service,
    settings: () => DEFAULT_SETTINGS,
    saveSettings: (settings) => {
      saved.push(settings);
      return Promise.resolve(settings);
    },
  };
  return { saved, service, state, handler };
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
    const { handler, saved, service, state } = context();
    expect(await handleRequest({ id: 1, method: 'getState' }, handler)).toEqual({
      id: 1,
      result: state,
    });

    expect(await handleRequest({ id: 2, method: 'refresh' }, handler)).toEqual({
      id: 2,
      result: null,
    });
    expect(service.refresh).toHaveBeenCalledWith(true);

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
    expect(service.sync).toHaveBeenCalledOnce();
  });

  it('turns failures into error responses', async () => {
    const { handler } = context();
    expect(await handleRequest({ id: 9, method: 'nope' }, handler)).toEqual({
      id: 9,
      error: 'Unknown method nope',
    });
  });
});
