import { createServer, type Server } from 'node:http';

import { tryLoadConfig } from '../config.js';
import { isUsageNotConfigured, usageEmptyMessage } from '../data/emptyState.js';
import type { ProviderData } from '../data/types.js';
import { loadMergedProviderData } from '../data/usageData.js';
import { type HtmlOperationalStatus, renderToHtml } from '../display/html/render.js';
import { isCloned } from '../git.js';
import { syncData } from './sync.js';

const DEFAULT_PORT = 9089;
const DEFAULT_INTERVAL = 120;
const DEFAULT_HOST = '127.0.0.1';

export interface DaemonOptions {
  port?: number;
  interval?: number;
  host?: string;
  sync?: boolean;
  dark?: boolean;
  providers?: string[];
  all?: boolean;
  year?: number;
}

export interface DaemonRuntimeStatus extends HtmlOperationalStatus {
  startedAt: string;
  intervalSeconds: number;
  providers: string[];
}

function resolveDaemonSettings(options: DaemonOptions): {
  port: number;
  interval: number;
  host: string;
  sync: boolean;
} {
  const config = tryLoadConfig();
  const daemon = config?.daemon;

  return {
    port: options.port ?? daemon?.port ?? DEFAULT_PORT,
    interval: options.interval ?? daemon?.interval ?? DEFAULT_INTERVAL,
    host: options.host ?? DEFAULT_HOST,
    sync: options.sync ?? daemon?.sync ?? false,
  };
}

export async function daemonCommand(options: DaemonOptions = {}): Promise<void> {
  const settings = resolveDaemonSettings(options);
  const renderOptions = {
    dark: Boolean(options.dark),
    all: Boolean(options.all),
    year: options.year,
    providers: options.providers,
  };
  const htmlOptions = {
    dark: renderOptions.dark,
    all: renderOptions.all,
    year: renderOptions.year,
    refreshIntervalSeconds: settings.interval,
  };

  const status: DaemonRuntimeStatus = {
    startedAt: new Date().toISOString(),
    intervalSeconds: settings.interval,
    refreshInProgress: false,
    syncEnabled: settings.sync,
    lastRefreshSuccessAt: null,
    lastSyncSuccessAt: null,
    nextRefreshAt: null,
    lastError: null,
    providers: [],
  };
  let cachedProviderData: ProviderData = {};
  let cachedEmptyMessage: string | undefined = 'Loading...';
  let cachedLastUpdated: Date | undefined;
  let cachedHtml = '';
  let hasRendered = false;
  let refreshPromise: Promise<void> | null = null;

  const renderCached = (): void => {
    cachedHtml = renderToHtml(cachedProviderData, {
      ...htmlOptions,
      ...(cachedLastUpdated === undefined ? {} : { lastUpdated: cachedLastUpdated }),
      ...(cachedEmptyMessage === undefined ? {} : { emptyMessage: cachedEmptyMessage }),
      operationalStatus: status,
    });
  };

  const performRefresh = async (): Promise<void> => {
    status.refreshInProgress = true;
    status.nextRefreshAt = null;
    renderCached();
    let phase: 'sync' | 'refresh' = settings.sync ? 'sync' : 'refresh';
    try {
      if (settings.sync) {
        if (!isCloned()) {
          throw new Error('Sync enabled but repo not cloned. Run: npx aitrack init');
        }
        await syncData({ quiet: true });
        status.lastSyncSuccessAt = new Date().toISOString();
      }

      phase = 'refresh';
      const loaded = await loadMergedProviderData({
        providers: renderOptions.providers,
        year: renderOptions.year,
      });

      const lastUpdated = new Date();
      status.lastRefreshSuccessAt = lastUpdated.toISOString();
      status.lastError = null;
      if (!loaded) {
        // Don't overwrite a previously-good render with the empty state — a
        // transient miss after we've shown real data shouldn't blank the page.
        if (hasRendered) return;
        cachedProviderData = {};
        cachedEmptyMessage = usageEmptyMessage(isUsageNotConfigured());
        cachedLastUpdated = lastUpdated;
        return;
      }

      cachedProviderData = loaded.providerData;
      cachedEmptyMessage = undefined;
      cachedLastUpdated = lastUpdated;
      status.providers = Object.keys(loaded.providerData);
      hasRendered = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.lastError = {
        phase,
        message,
        at: new Date().toISOString(),
      };
      console.error(`aitrack daemon refresh failed: ${message}`);
    } finally {
      status.refreshInProgress = false;
      status.nextRefreshAt = new Date(Date.now() + settings.interval * 1000).toISOString();
      renderCached();
    }
  };

  const refresh = (): Promise<void> => {
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  };

  renderCached();
  await refresh();

  const server: Server = createServer((request, res) => {
    const path = request.url?.split('?', 1)[0];
    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(cachedHtml);
      return;
    }
    if (
      request.method === 'GET' &&
      (path === '/healthz' || path === '/readyz' || path === '/status.json')
    ) {
      const isReady = status.lastRefreshSuccessAt !== null && status.lastError === null;
      const body =
        path === '/healthz'
          ? {
              status: 'ok',
              uptimeSeconds: Math.max(
                0,
                Math.floor((Date.now() - Date.parse(status.startedAt)) / 1000),
              ),
            }
          : {
              ...status,
              state: status.refreshInProgress
                ? 'refreshing'
                : status.lastError
                  ? 'degraded'
                  : isReady
                    ? 'ready'
                    : 'starting',
            };
      res.writeHead(path === '/readyz' && !isReady ? 503 : 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(settings.port, settings.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : settings.port;
      console.log(
        `aitrack daemon listening on http://${settings.host}:${String(port)} (refresh every ${String(settings.interval)}s)`,
      );
      resolve();
    });
    server.on('error', reject);
  });

  const refreshTimer = setInterval(() => {
    void refresh();
  }, settings.interval * 1000);

  const shutdown = (): void => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    clearInterval(refreshTimer);
    server.close(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
