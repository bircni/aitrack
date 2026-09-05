import type { IncomingMessage, ServerResponse } from 'node:http';

import { makeDay } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
  syncData: vi.fn(),
  loadMergedProviderData: vi.fn(),
  renderToHtml: vi.fn(),
  createServer: vi.fn(),
}));

vi.mock('aitrack-lib/config', () => ({
  tryLoadConfig: mocks.tryLoadConfig,
}));
vi.mock('aitrack-lib/git', () => ({
  isCloned: mocks.isCloned,
}));
vi.mock('../sync.js', () => ({
  syncData: mocks.syncData,
}));
vi.mock('aitrack-lib/data/usageData', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  emptyUsageMessage: () => 'No usage data found.',
}));
vi.mock('aitrack-lib/display/html/render', () => ({
  renderToHtml: mocks.renderToHtml,
}));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: mocks.createServer,
  };
});

import { daemonCommand } from '../daemon.js';

type RequestHandler = (request: IncomingMessage, res: ServerResponse) => void;

describe('daemonCommand', () => {
  let requestHandler: RequestHandler | undefined;
  let listenCallback: (() => void) | undefined;
  const fakeServer = {
    listen: vi.fn((port: number, _host: string, callback: () => void) => {
      listenCallback = callback;
      callback();
    }),
    close: vi.fn((callback?: () => void) => callback?.()),
    on: vi.fn(),
    address: vi.fn(() => ({ port: 9089, address: '127.0.0.1' })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    requestHandler = undefined;
    listenCallback = undefined;
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);
    mocks.syncData.mockResolvedValue(undefined);
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: { claude_code: new Map([['2024-06-01', makeDay(100, 50)]]) },
      machineData: [],
    });
    mocks.renderToHtml.mockImplementation(
      (_data: unknown, _machines: unknown, options?: { emptyMessage?: string }) =>
        `<html>${options?.emptyMessage ?? 'dashboard'}</html>`,
    );
    mocks.createServer.mockImplementation((handler: RequestHandler) => {
      requestHandler = handler;
      return fakeServer;
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes refresh interval to renderToHtml', async () => {
    const daemonPromise = daemonCommand({ port: 9089, interval: 45 });

    await vi.waitFor(() => {
      expect(mocks.renderToHtml).toHaveBeenCalled();
    });

    expect(mocks.renderToHtml).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refreshIntervalSeconds: 45 }),
    );

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('serves cached HTML on GET /', async () => {
    const daemonPromise = daemonCommand({ port: 9089, interval: 120 });

    await vi.waitFor(() => {
      expect(listenCallback).toBeDefined();
      expect(requestHandler).toBeDefined();
    });

    const chunks: string[] = [];
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((body: string) => {
        chunks.push(body);
      }),
    };
    if (!requestHandler) throw new Error('expected request handler');
    requestHandler(
      { method: 'GET', url: '/' } as IncomingMessage,
      res as unknown as ServerResponse,
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    expect(chunks[0]).toContain('dashboard');
    expect(mocks.loadMergedProviderData).toHaveBeenCalled();

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('refreshes data on interval', async () => {
    const daemonPromise = daemonCommand({ port: 9089, interval: 60 });

    await vi.waitFor(() => {
      expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(1);
    });

    mocks.renderToHtml.mockImplementation(() => '<html>refreshed</html>');
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(2);
    });

    const chunks: string[] = [];
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((body: string) => {
        chunks.push(body);
      }),
    };
    if (!requestHandler) throw new Error('expected request handler');
    requestHandler(
      { method: 'GET', url: '/' } as IncomingMessage,
      res as unknown as ServerResponse,
    );
    expect(chunks[0]).toContain('refreshed');

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('coalesces interval ticks while a refresh is still running', async () => {
    const loaded = {
      providerData: { claude_code: new Map([['2024-06-01', makeDay(100, 50)]]) },
      machineData: [],
    };
    let finishRefresh: (() => void) | undefined;
    mocks.loadMergedProviderData.mockResolvedValueOnce(loaded).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => {
            resolve(loaded);
          };
        }),
    );

    const daemonPromise = daemonCommand({ port: 9089, interval: 60 });
    await vi.waitFor(() => {
      expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(2);
      expect(finishRefresh).toBeDefined();
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(2);

    finishRefresh?.();
    await vi.waitFor(() => {
      expect(mocks.renderToHtml).toHaveBeenCalled();
    });
    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('runs sync when sync option is enabled', async () => {
    mocks.isCloned.mockReturnValue(true);
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });

    const daemonPromise = daemonCommand({ port: 9089, interval: 120, sync: true });

    await vi.waitFor(() => {
      expect(mocks.syncData).toHaveBeenCalledWith({ quiet: true });
    });

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('reuses the machine file from sync instead of re-reading the logs', async () => {
    const localMachine = { hostname: 'host', lastUpdated: 'now', days: {} };
    mocks.isCloned.mockReturnValue(true);
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.syncData.mockResolvedValue(localMachine);

    const daemonPromise = daemonCommand({ port: 9089, interval: 120, sync: true });

    // Without this the refresh parses the whole JSONL corpus a second time,
    // once inside syncData and once inside loadMergedProviderData.
    await vi.waitFor(() => {
      expect(mocks.loadMergedProviderData).toHaveBeenCalledWith(
        expect.objectContaining({ localMachine }),
      );
    });

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('reports a sync configuration error but still starts the dashboard server', async () => {
    const daemonPromise = daemonCommand({ port: 9089, interval: 120, sync: true });

    await vi.waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'aitrack daemon refresh failed: Sync enabled but repo not cloned. Run: npx aitrack init',
      );
      expect(fakeServer.listen).toHaveBeenCalled();
    });

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('does not pull or push when sync is disabled and repo is cloned', async () => {
    mocks.isCloned.mockReturnValue(true);

    const daemonPromise = daemonCommand({ port: 9089, interval: 120, sync: false });

    await vi.waitFor(() => {
      expect(mocks.loadMergedProviderData).toHaveBeenCalled();
    });
    expect(mocks.syncData).not.toHaveBeenCalled();

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('returns 404 for unknown routes', async () => {
    const daemonPromise = daemonCommand({ port: 9089, interval: 120 });

    await vi.waitFor(() => {
      expect(requestHandler).toBeDefined();
    });

    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    if (!requestHandler) throw new Error('expected request handler');
    requestHandler(
      { method: 'GET', url: '/api/status' } as IncomingMessage,
      res as unknown as ServerResponse,
    );

    expect(res.writeHead).toHaveBeenCalledWith(404, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    expect(res.end).toHaveBeenCalledWith('Not found');

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('uses daemon defaults from config when options are omitted', async () => {
    mocks.tryLoadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      daemon: { port: 9091, interval: 45, sync: true },
    });
    mocks.isCloned.mockReturnValue(true);

    const daemonPromise = daemonCommand({});

    fakeServer.address.mockReturnValue({ port: 9091, address: '127.0.0.1' });
    await vi.waitFor(() => {
      expect(fakeServer.listen).toHaveBeenCalledWith(9091, '127.0.0.1', expect.any(Function));
    });
    expect(mocks.syncData).toHaveBeenCalledWith({ quiet: true });

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('logs refresh failures without crashing the server', async () => {
    mocks.loadMergedProviderData.mockRejectedValueOnce(new Error('refresh blew up'));

    const daemonPromise = daemonCommand({ port: 9089, interval: 120 });

    await vi.waitFor(() => {
      expect(console.error).toHaveBeenCalledWith('aitrack daemon refresh failed: refresh blew up');
    });

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('reports readiness and the last refresh failure as JSON', async () => {
    mocks.loadMergedProviderData.mockRejectedValueOnce(new Error('refresh blew up'));
    const daemonPromise = daemonCommand({ port: 9089, interval: 120 });

    await vi.waitFor(() => {
      expect(requestHandler).toBeDefined();
    });

    const chunks: string[] = [];
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((body: string) => {
        chunks.push(body);
      }),
    };
    if (!requestHandler) throw new Error('expected request handler');
    requestHandler(
      { method: 'GET', url: '/readyz' } as IncomingMessage,
      res as unknown as ServerResponse,
    );

    expect(res.writeHead).toHaveBeenCalledWith(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    expect(JSON.parse(chunks[0] ?? '{}')).toMatchObject({
      state: 'degraded',
      lastError: { phase: 'refresh', message: 'refresh blew up' },
    });

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('renders an empty-state dashboard when the initial refresh has no data', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    const daemonPromise = daemonCommand({ port: 9089, interval: 120 });

    await vi.waitFor(() => {
      expect(mocks.renderToHtml).toHaveBeenLastCalledWith(
        {},
        expect.objectContaining({
          emptyMessage:
            'No local usage data found (Claude Code or Codex). Run: npx aitrack init to sync across machines.',
        }),
      );
    });

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('keeps the last good render when a later refresh returns no data', async () => {
    mocks.loadMergedProviderData
      .mockResolvedValueOnce({
        providerData: { claude_code: new Map([['2024-06-01', makeDay(100, 50)]]) },
        machineData: [],
      })
      .mockResolvedValueOnce(null);

    const daemonPromise = daemonCommand({ port: 9089, interval: 60 });

    await vi.waitFor(() => {
      expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(2);
    });

    const chunks: string[] = [];
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((body: string) => {
        chunks.push(body);
      }),
    };
    if (!requestHandler) throw new Error('expected request handler');
    requestHandler(
      { method: 'GET', url: '/' } as IncomingMessage,
      res as unknown as ServerResponse,
    );

    expect(chunks[0]).toContain('dashboard');

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });
});
