import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
  syncData: vi.fn(),
  loadMergedProviderData: vi.fn(),
  renderToHtml: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  tryLoadConfig: mocks.tryLoadConfig,
}));
vi.mock('../../git.js', () => ({
  isCloned: mocks.isCloned,
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

import { daemonCommand } from '../daemon.js';

function makeDay(input: number, output: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    byModel: { model: { inputTokens: input, outputTokens: output } },
  };
}

describe('daemon HTTP integration', () => {
  const logs: string[] = [];
  let exitSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    logs.length = 0;
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: { claude_code: new Map([['2024-06-01', makeDay(100, 50)]]) },
      machineData: [],
      fileCount: 0,
    });
    mocks.renderToHtml.mockImplementation(
      (_data: unknown, opts?: { emptyMessage?: string }) =>
        `<html>${opts?.emptyMessage ?? 'live-dashboard'}</html>`,
    );
    vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    exitSpy.mockRestore();
  });

  it('serves GET / and /index.html from a real HTTP listener', async () => {
    const daemonPromise = daemonCommand({ port: 0, interval: 3600, host: '127.0.0.1' });

    await vi.waitFor(() => {
      expect(logs.some((line) => line.includes('listening on http://127.0.0.1:'))).toBe(true);
    });

    const listenLine = logs.find((line) => line.includes('listening on http://127.0.0.1:'));
    const port = listenLine?.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    expect(port).toBeDefined();
    if (port === undefined) throw new Error('expected daemon to log listen URL');

    const base = `http://127.0.0.1:${port}`;
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('live-dashboard');

    const index = await fetch(`${base}/index.html`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('live-dashboard');

    const missing = await fetch(`${base}/missing`);
    expect(missing.status).toBe(404);

    process.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    void daemonPromise;
  });
});
