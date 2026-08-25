import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isUsageNotConfigured, usageEmptyMessage } from '../data/emptyState.js';
import { loadMergedProviderData } from '../data/usageData.js';
import { renderToPng } from '../display/renderPng.js';
import { renderTui } from '../display/tui.js';
import { log } from '../output.js';

function openFile(filePath: string): void {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', filePath], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
    return;
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [filePath], { detached: true, stdio: 'ignore' }).unref();
}

interface ShowOptions {
  output?: string;
  dark?: boolean;
  providers?: string[];
  all?: boolean;
  open?: boolean;
  year?: number;
  tui?: boolean;
}

export async function showCommand(options: ShowOptions = {}): Promise<void> {
  const loaded = await loadMergedProviderData({
    providers: options.providers,
    year: options.year,
    stagePending: true,
  });

  if (!loaded) {
    log.info(usageEmptyMessage(isUsageNotConfigured()));
    return;
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
