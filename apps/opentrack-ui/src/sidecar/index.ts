import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { tryLoadConfig } from 'aitrack-lib/config';
import { isRecord } from 'aitrack-lib/data/guards';
import type { MachineFile } from 'aitrack-lib/data/types';
import { loadMergedProviderData } from 'aitrack-lib/data/usageData';
import { errorMessage } from 'aitrack-lib/errors';
import { isCloned, pull } from 'aitrack-lib/git';
import { fetchQuota } from 'aitrack-lib/quota/index';
import { syncData } from 'aitrack-lib/sync';

import type { Settings } from '../shared/types.js';
import { handleRequest, parseRequest, type SidecarMessage } from './protocol.js';
import { normalizeCachedState, QuotaService } from './service.js';
import { loadSettings, readJsonFile, writeJsonFile } from './settings.js';
import { renderTrayIcon, summarizeTray } from './trayIcon.js';
import { summarizeUsage } from './usage.js';

const TICK_MS = 60_000;
const TRAY_ICON_SIZE = 32;
const GIT_TIMEOUT_MS = 60_000;
/** Bump only for incompatible cache shapes; additive fields are filled with defaults. */
const CACHE_FORMAT = 2;

// stdout is the protocol channel; anything the library prints goes to stderr.
console.log = console.error;
console.info = console.error;
// Refreshes run fire-and-forget; a failure belongs in sidecar.log, not in a crash-restart.
process.on('unhandledRejection', (error) => {
  console.error('opentrack sidecar:', error);
});

function send(message: SidecarMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadUsage(options: {
  pull: boolean;
  refreshLive: boolean;
  localMachine?: MachineFile;
}) {
  let warning: string | undefined;
  if (options.pull && tryLoadConfig() && isCloned()) {
    try {
      await pull({ timeoutMs: GIT_TIMEOUT_MS });
    } catch (error) {
      warning = `Could not pull synced data: ${errorMessage(error)}`;
    }
  }
  const loaded = await loadMergedProviderData({
    refreshLive: options.refreshLive,
    localMachine: options.localMachine,
  });
  return { summary: summarizeUsage(loaded), warning };
}

async function main(): Promise<void> {
  const dataDir = argument('--data-dir') ?? process.cwd();
  const settingsPath = join(dataDir, 'settings.json');
  const cachePath = join(dataDir, 'cache.json');
  let settings: Settings = await loadSettings(settingsPath);
  const raw = await readJsonFile(cachePath);
  const cached = normalizeCachedState(isRecord(raw) && raw.format === CACHE_FORMAT ? raw : {});
  let lastTray = '';

  const service = new QuotaService(
    {
      fetchQuota: (provider) => fetchQuota(provider),
      loadUsage,
      now: () => Date.now(),
      onState: (state) => {
        send({ event: 'state', data: state });
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
        writeJsonFile(cachePath, { format: CACHE_FORMAT, ...cache }).catch(() => undefined);
      },
      sync: () => syncData({ timeoutMs: GIT_TIMEOUT_MS }),
    },
    settings,
    cached,
  );

  const context = {
    service,
    settings: () => settings,
    saveSettings: async (next: Settings) => {
      await writeJsonFile(settingsPath, next);
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
