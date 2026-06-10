import { exec } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { tryLoadConfig } from '../config.js';
import { emptyUsageMessage, loadMergedProviderData } from '../data/usageData.js';
import { renderToPng } from '../display/renderPng.js';
import { renderTui } from '../display/tui.js';
import { isCloned } from '../git.js';

function openFile(filePath: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${filePath}"`
      : process.platform === 'darwin'
        ? `open "${filePath}"`
        : `xdg-open "${filePath}"`;
  exec(cmd);
}

interface ShowOptions {
  output?: string;
  dark?: boolean;
  noCursor?: boolean;
  all?: boolean;
  open?: boolean;
  year?: number;
  tui?: boolean;
}

export async function showCommand(opts: ShowOptions = {}): Promise<void> {
  const loaded = await loadMergedProviderData({
    noCursor: opts.noCursor,
    year: opts.year,
  });

  if (!loaded) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  if (opts.tui) {
    const output = renderTui(loaded.providerData, {
      dark: opts.dark,
      all: opts.all,
      year: opts.year,
    });
    console.log(output || 'No usage data found.');
    return;
  }

  const outputPath = resolve(opts.output ?? 'aitrack.png');
  const png = renderToPng(loaded.providerData, loaded.machineData, {
    dark: Boolean(opts.dark),
    all: Boolean(opts.all),
    year: opts.year,
  });
  writeFileSync(outputPath, png);

  console.log(`Saved: ${outputPath}`);
  if (opts.open !== false) openFile(outputPath);
}

export {
  emptyUsageMessage,
  type LoadedUsageData,
  loadMergedProviderData,
  type LoadUsageOptions,
  mergeProviderDay,
} from '../data/usageData.js';
