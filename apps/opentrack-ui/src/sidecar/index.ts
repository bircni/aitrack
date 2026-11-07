import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { writeFileAtomic } from 'aitrack-lib/atomicWrite';
import { fetchQuota } from 'aitrack-lib/quota/index';
import { syncData } from 'aitrack-lib/sync';

import type { Settings } from '../shared/types.js';
import {
  handleRequest,
  parseRequest,
  serializeMessage,
  type SidecarMessage,
  stateWriter,
} from './protocol.js';
import { CACHE_FORMAT, loadCachedState, QuotaService } from './service.js';
import { loadSettings, readJsonFile, writeJsonFile } from './settings.js';
import { renderTrayIcon, summarizeTray } from './trayIcon.js';
import { GIT_TIMEOUT_MS, loadUsageSummary } from './usage.js';

const TICK_MS = 60_000;
const TRAY_ICON_SIZE = 32;

// stdout is the protocol channel; anything the library prints goes to stderr.
console.log = console.error;
console.info = console.error;
// Refreshes run fire-and-forget; a failure belongs in sidecar.log, not in a crash-restart.
process.on('unhandledRejection', (error) => {
  console.error('opentrack sidecar:', error);
});

function send(message: SidecarMessage): void {
  process.stdout.write(serializeMessage(message));
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const dataDir = argument('--data-dir') ?? process.cwd();
  const settingsPath = join(dataDir, 'settings.json');
  const cachePath = join(dataDir, 'cache.json');
  let settings: Settings = await loadSettings(settingsPath);
  const raw = await readJsonFile(cachePath);
  const cached = loadCachedState(raw);
  let lastTray = '';
  const sendState = stateWriter((line) => {
    process.stdout.write(line);
  });

  const service = new QuotaService(
    {
      fetchQuota: (provider) => fetchQuota(provider),
      loadUsage: loadUsageSummary,
      now: () => Date.now(),
      onState: (state) => {
        sendState(state);
        // Past the writer's check: a repeated state can still mean a new tray setting or a passed reset.
        const summary = summarizeTray(state.providers, Date.now(), settings);
        const key = JSON.stringify([summary, settings.trayStyle, settings.trayColored]);
        if (key === lastTray) return;
        lastTray = key;
        const rgba = renderTrayIcon(TRAY_ICON_SIZE, summary.usedPercent, summary.tone, {
          style: settings.trayStyle,
          colored: settings.trayColored,
          bars: summary.bars,
        }).toString('base64');
        send({
          event: 'tray',
          data: {
            rgba,
            size: TRAY_ICON_SIZE,
            tooltip: summary.tooltip,
            template: !settings.trayColored,
          },
        });
      },
      onAlert: (alert) => {
        send({ event: 'alert', data: { title: alert.title, body: alert.body } });
      },
      persist: (cache) => {
        try {
          writeFileAtomic(cachePath, JSON.stringify({ format: CACHE_FORMAT, ...cache }));
        } catch (error) {
          console.error('opentrack sidecar:', error); // The next cycle tries again.
        }
      },
      sync: () => syncData({ timeoutMs: GIT_TIMEOUT_MS }),
    },
    settings,
    cached,
  );

  const context = {
    service,
    settings: () => settings,
    saveSettings: (next: Settings) => {
      writeJsonFile(settingsPath, next);
      settings = next;
      service.setSettings(settings);
      send({ event: 'settings', data: settings });
      void service.refresh();
      return settings;
    },
  };

  // Exercise the real startup and protocol from an installer without accessing
  // provider credentials, usage logs or the configured sync repository.
  if (process.argv.includes('--smoke-test')) {
    send(await handleRequest({ id: 1, method: 'getSettings' }, context));
    send(await handleRequest({ id: 2, method: 'getState' }, context));
    return;
  }

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const request = parseRequest(line);
    if (request) void handleRequest(request, context).then(send);
  });
  // The shell owns this process; when it goes, so do we.
  lines.on('close', () => {
    process.exit(0);
  });

  send({ event: 'settings', data: settings });
  void service.refresh();
  setInterval(() => {
    void service.refresh();
  }, TICK_MS);
}

void main();
