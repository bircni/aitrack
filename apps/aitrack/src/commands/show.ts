import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveMachineId, tryLoadConfig } from 'aitrack-lib/config';
import {
  isUsageNotConfigured,
  usageEmptyMessage,
  usageEmptyWindowMessage,
} from 'aitrack-lib/data/emptyState';
import { buildLocalMachineFile } from 'aitrack-lib/data/localData';
import type { MachineFile } from 'aitrack-lib/data/types';
import { loadMergedProviderData } from 'aitrack-lib/data/usageData';
import { machineZones } from 'aitrack-lib/data/usageReport';
import { renderToPng } from 'aitrack-lib/display/renderPng';
import { renderTui, tuiStats } from 'aitrack-lib/display/tui';
import { errorMessage } from 'aitrack-lib/errors';
import { isCloned, writePendingMachineFile } from 'aitrack-lib/git';
import { log } from 'aitrack-lib/output';
import { warnAboutPricingFallbacks } from 'aitrack-lib/pricing/scan';

import { printEmptyResult, printJsonCommand } from '../cli/json.js';

function openFile(filePath: string): void {
  const opener =
    process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  spawn(opener, [filePath], { detached: true, stdio: 'ignore' })
    .on('error', (error) => {
      log.warn(
        `Could not run ${opener} (${error.message}). Open the file manually or pass --no-open.`,
      );
    })
    .unref();
}

export interface ShowOptions {
  output?: string;
  dark?: boolean;
  providers?: string[];
  all?: boolean;
  open?: boolean;
  year?: number;
  tui?: boolean;
  refresh?: boolean;
  json?: boolean;
}

/** Keeps a read-only report working when the staging folder cannot be written. */
async function stagedLocalMachine(machineId: string): Promise<MachineFile> {
  const localMachine = await buildLocalMachineFile(machineId);
  try {
    writePendingMachineFile(localMachine);
  } catch (error) {
    log.warn(`Could not stage local usage for a later init: ${errorMessage(error)}`);
  }
  return localMachine;
}

export async function showCommand(options: ShowOptions = {}): Promise<void> {
  if (options.tui && options.output !== undefined) {
    log.warn('--output is ignored with --tui, which writes no file.');
  }
  const config = tryLoadConfig();
  // Staging exists so a later `init` can adopt usage recorded before the repo
  // was set up. Once configured and cloned, sync writes into the repo directly.
  const isStaging = !config || !isCloned();
  const localMachine = isStaging ? await stagedLocalMachine(resolveMachineId(config)) : undefined;

  const loaded = await loadMergedProviderData({
    providers: options.providers,
    refreshLive: options.refresh,
    ...(localMachine !== undefined && { localMachine }),
  });

  const emptyPayload = options.tui
    ? {
        mode: 'tui',
        ...(options.year !== undefined && { year: options.year }),
        providers: [],
        total: null,
      }
    : { mode: 'png', path: null };
  const emptyMessage = (): string =>
    options.year === undefined
      ? usageEmptyMessage(isUsageNotConfigured(), options.providers)
      : usageEmptyWindowMessage(String(options.year));

  if (!loaded) {
    printEmptyResult('show', options.json, emptyMessage(), emptyPayload);
    return;
  }

  warnAboutPricingFallbacks(loaded.providerData);

  const { rows, footer } = tuiStats(loaded.providerData, {
    all: options.all,
    year: options.year,
  });
  if (rows.length === 0) {
    printEmptyResult('show', options.json, emptyMessage(), emptyPayload); // A PNG here would be blank, and could replace a good one.
    return;
  }

  const zones = machineZones(loaded.zonedSources);
  if (zones.length > 0) {
    log.info(`Heatmap days are each machine's local dates (${zones.join(', ')}).`);
  }

  if (options.tui && options.json) {
    printJsonCommand('show', {
      mode: 'tui',
      ...(options.year !== undefined && { year: options.year }),
      providers: rows,
      total: footer ?? null,
    });
    return;
  }

  if (options.tui) {
    log.info(
      renderTui(loaded.providerData, {
        dark: options.dark,
        all: options.all,
        year: options.year,
      }),
    );
    return;
  }

  const outputPath = resolve(options.output ?? 'aitrack.png');
  const png = renderToPng(loaded.providerData, {
    dark: Boolean(options.dark),
    all: Boolean(options.all),
    year: options.year,
  });
  writeFileSync(outputPath, png);

  if (options.json) {
    printJsonCommand('show', { mode: 'png', path: outputPath });
  } else {
    log.info(`Saved: ${outputPath}`);
  }
  if (options.open !== false) openFile(outputPath);
}
