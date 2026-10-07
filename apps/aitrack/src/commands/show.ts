import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveMachineId, tryLoadConfig } from 'aitrack-lib/config';
import { isUsageNotConfigured, usageEmptyMessage } from 'aitrack-lib/data/emptyState';
import { buildLocalMachineFile } from 'aitrack-lib/data/localData';
import { loadMergedProviderData } from 'aitrack-lib/data/usageData';
import { machineZones } from 'aitrack-lib/data/usageReport';
import { renderToPng } from 'aitrack-lib/display/renderPng';
import { renderTui } from 'aitrack-lib/display/tui';
import { isCloned, writePendingMachineFile } from 'aitrack-lib/git';
import { log } from 'aitrack-lib/output';
import { warnAboutPricingFallbacks } from 'aitrack-lib/pricing/scan';

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
}

export async function showCommand(options: ShowOptions = {}): Promise<void> {
  const config = tryLoadConfig();
  const localMachine = await buildLocalMachineFile(resolveMachineId(config));
  // Staging exists so a later `init` can adopt usage recorded before the repo
  // was set up. Once configured and cloned, sync writes into the repo directly.
  if (!config || !isCloned()) {
    writePendingMachineFile(localMachine);
  }

  const loaded = await loadMergedProviderData({
    providers: options.providers,
    refreshLive: options.refresh,
    localMachine,
  });

  if (!loaded) {
    log.info(usageEmptyMessage(isUsageNotConfigured()));
    return;
  }

  warnAboutPricingFallbacks(loaded.providerData);
  const zones = machineZones(loaded.zonedSources);
  if (zones.length > 0) {
    log.info(`Heatmap days are each machine's local dates (${zones.join(', ')}).`);
  }

  if (options.tui) {
    const output = renderTui(loaded.providerData, {
      dark: options.dark,
      all: options.all,
      year: options.year,
    });
    log.info(output || usageEmptyMessage(loaded.warnedNotConfigured));
    return;
  }

  const outputPath = resolve(options.output ?? 'aitrack.png');
  const png = renderToPng(loaded.providerData, {
    dark: Boolean(options.dark),
    all: Boolean(options.all),
    year: options.year,
  });
  writeFileSync(outputPath, png);

  log.info(`Saved: ${outputPath}`);
  if (options.open !== false) openFile(outputPath);
}
