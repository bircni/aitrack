import { createServer, type Server } from 'node:http';

import { tryLoadConfig } from '../config.js';
import { isUsageNotConfigured, usageEmptyMessage } from '../data/emptyState.js';
import { loadMergedProviderData } from '../data/usageData.js';
import { renderToHtml } from '../display/html/render.js';
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

  let cachedHtml = renderToHtml(
    {},
    {
      ...htmlOptions,
      emptyMessage: 'Loading...',
    },
  );
  let hasRendered = false;

  const refresh = async (): Promise<void> => {
    try {
      if (settings.sync) {
        if (!isCloned()) {
          throw new Error('Sync enabled but repo not cloned. Run: npx aitrack init');
        }
        await syncData({ quiet: true });
      }

      const loaded = await loadMergedProviderData({
        providers: renderOptions.providers,
        year: renderOptions.year,
      });

      const lastUpdated = new Date();
      if (!loaded) {
        // Don't overwrite a previously-good render with the empty state — a
        // transient miss after we've shown real data shouldn't blank the page.
        if (hasRendered) return;
        cachedHtml = renderToHtml(
          {},
          {
            ...htmlOptions,
            lastUpdated,
            emptyMessage: usageEmptyMessage(isUsageNotConfigured()),
          },
        );
        return;
      }

      cachedHtml = renderToHtml(loaded.providerData, {
        ...htmlOptions,
        lastUpdated,
      });
      hasRendered = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`aitrack daemon refresh failed: ${message}`);
    }
  };

  await refresh();

  const server: Server = createServer((request, res) => {
    if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(cachedHtml);
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
