import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
  tryPull: vi.fn(),
  syncData: vi.fn(),
  loadMergedProviderData: vi.fn(),
  renderToHtml: vi.fn(),
  createServer: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  tryLoadConfig: mocks.tryLoadConfig,
}));
vi.mock('../../git.js', () => ({
  isCloned: mocks.isCloned,
  tryPull: mocks.tryPull,
}));
vi.mock('../sync.js', () => ({
  syncData: mocks.syncData,
}));
vi.mock('../../data/usageData.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  emptyUsageMessage: () => 'No usage data found.',
}));
vi.mock('../../display/html/render.js', () => ({
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

function makeDay(input: number, output: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    byModel: { model: { inputTokens: input, outputTokens: output } },
  };
}

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

describe('daemonCommand', () => {
  let requestHandler: RequestHandler | undefined;
  let listenCallback: (() => void) | undefined;
  const fakeServer = {
    listen: vi.fn((port: number, _host: string, cb: () => void) => {
      listenCallback = cb;
      cb();
    }),
    close: vi.fn((cb?: () => void) => cb?.()),
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
      fileCount: 0,
    });
    mocks.renderToHtml.mockImplementation(
      (_data: unknown, _machines: unknown, opts?: { emptyMessage?: string }) =>
        `<html>${opts?.emptyMessage ?? 'dashboard'}</html>`,
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

  it('serves cached HTML on GET /', async () => {
    const daemonPromise = daemonCommand({ port: 9089, interval: 120 });

    await vi.waitFor(() => {
      expect(listenCallback).toBeDefined();
      expect(requestHandler).toBeDefined();
    });

    const chunks: string[] = [];
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((body: string) => chunks.push(body)),
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
      end: vi.fn((body: string) => chunks.push(body)),
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

  it('runs sync when sync option is enabled', async () => {
    mocks.isCloned.mockReturnValue(true);
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });

    const daemonPromise = daemonCommand({ port: 9089, interval: 120, sync: true });

    await vi.waitFor(() => {
      expect(mocks.syncData).toHaveBeenCalledWith({ quiet: true });
    });
    expect(mocks.tryPull).not.toHaveBeenCalled();

    process.emit('SIGTERM');
    await daemonPromise.catch(() => undefined);
  });

  it('pulls quietly when sync is disabled and repo is cloned', async () => {
    mocks.isCloned.mockReturnValue(true);

    const daemonPromise = daemonCommand({ port: 9089, interval: 120, sync: false });

    await vi.waitFor(() => {
      expect(mocks.tryPull).toHaveBeenCalledWith({ quiet: true });
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

  it('keeps the last good render when a later refresh returns no data', async () => {
    mocks.loadMergedProviderData
      .mockResolvedValueOnce({
        providerData: { claude_code: new Map([['2024-06-01', makeDay(100, 50)]]) },
        machineData: [],
        fileCount: 0,
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
      end: vi.fn((body: string) => chunks.push(body)),
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
