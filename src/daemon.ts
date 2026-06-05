import { createServer, type Server } from 'node:http';

import { tryLoadConfig } from './config.js';
import { isCloned, tryPull } from './git.js';
import { renderToHtml } from './html.js';
import { emptyUsageMessage, loadMergedProviderData } from './show.js';
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
  noCursor?: boolean;
  all?: boolean;
  year?: number;
}

function resolveDaemonSettings(opts: DaemonOptions): {
  port: number;
  interval: number;
  host: string;
  sync: boolean;
} {
  const config = tryLoadConfig();
  const daemon = config?.daemon;

  return {
    port: opts.port ?? daemon?.port ?? DEFAULT_PORT,
    interval: opts.interval ?? daemon?.interval ?? DEFAULT_INTERVAL,
    host: opts.host ?? DEFAULT_HOST,
    sync: opts.sync ?? daemon?.sync ?? false,
  };
}

export async function daemonCommand(opts: DaemonOptions = {}): Promise<void> {
  const settings = resolveDaemonSettings(opts);
  const renderOpts = {
    dark: Boolean(opts.dark),
    all: Boolean(opts.all),
    year: opts.year,
    noCursor: opts.noCursor,
  };

  let cachedHtml = renderToHtml(
    {},
    {
      dark: renderOpts.dark,
      year: renderOpts.year,
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
      } else if (isCloned()) {
        tryPull({ quiet: true });
      }

      const loaded = await loadMergedProviderData({
        noCursor: renderOpts.noCursor,
        year: renderOpts.year,
      });

      const lastUpdated = new Date();
      if (!loaded) {
        // Don't overwrite a previously-good render with the empty state — a
        // transient miss after we've shown real data shouldn't blank the page.
        if (hasRendered) return;
        const config = tryLoadConfig();
        cachedHtml = renderToHtml(
          {},
          {
            dark: renderOpts.dark,
            year: renderOpts.year,
            lastUpdated,
            emptyMessage: emptyUsageMessage(!config || !isCloned()),
          },
        );
        return;
      }

      cachedHtml = renderToHtml(loaded.providerData, {
        dark: renderOpts.dark,
        all: renderOpts.all,
        year: renderOpts.year,
        lastUpdated,
      });
      hasRendered = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`aitrack daemon refresh failed: ${message}`);
    }
  };

  await refresh();

  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
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
      console.log(
        `aitrack daemon listening on http://${settings.host}:${String(settings.port)} (refresh every ${String(settings.interval)}s)`,
      );
      resolve();
    });
    server.on('error', reject);
  });

  const refreshTimer = setInterval(() => {
    void refresh();
  }, settings.interval * 1000);

  const shutdown = (): void => {
    clearInterval(refreshTimer);
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
