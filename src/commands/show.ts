import { exec } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { tryLoadConfig } from '../config.js';
import { emptyUsageMessage, loadMergedProviderData } from '../data/usageData.js';
import { renderToPng } from '../display/renderPng.js';
import { renderTui } from '../display/tui.js';
import { isCloned } from '../git.js';

function openFile(filePath: string): void {
  const command =
    process.platform === 'win32'
      ? `start "" "${filePath}"`
      : process.platform === 'darwin'
        ? `open "${filePath}"`
        : `xdg-open "${filePath}"`;
  exec(command);
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
  });

  if (!loaded) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  if (options.tui) {
    const output = renderTui(loaded.providerData, {
      dark: options.dark,
      all: options.all,
      year: options.year,
    });
    console.log(output || 'No usage data found.');
    return;
  }

  const outputPath = resolve(options.output ?? 'aitrack.png');
  const png = renderToPng(loaded.providerData, loaded.machineData, {
    dark: Boolean(options.dark),
    all: Boolean(options.all),
    year: options.year,
  });
  writeFileSync(outputPath, png);

  console.log(`Saved: ${outputPath}`);
  if (options.open !== false) openFile(outputPath);
}
