import { exec } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { resolveMachineId, tryLoadConfig } from './config.js';
import { filterProviderDataByYear, getOrCreateDay } from './dayMap.js';
import { isCloned, listDataFiles, readDataFile, tryPull, writePendingMachineFile } from './git.js';
import { buildLocalMachineFile, machineHasData } from './localData.js';
import { estimateCodexCostUSD } from './pricing/codex.js';
import { estimateClaudeCostFromAggregateTokens } from './readers/claude.js';
import { readCursorData } from './readers/cursor.js';
import { mergeAllProviderDayMaps, renderToPng } from './render.js';
import { renderTui } from './tui.js';
import type { DayEntry, MachineFile, ProviderData, ProviderDay, TokenCounts } from './types.js';

// Resolve the per-model cost for one provider-day, backfilling claude_code rows
// from aggregate token counts when sync wrote no costUSD (older data).
function resolveModelCost(
  providerKey: string,
  model: string,
  counts: TokenCounts,
  usageDate?: string,
): number | undefined {
  if (counts.costUSD !== undefined) return counts.costUSD;
  if (providerKey === 'claude_code') {
    return estimateClaudeCostFromAggregateTokens(
      model,
      counts.inputTokens,
      counts.outputTokens,
      usageDate,
    );
  }
  if (providerKey === 'codex') {
    return estimateCodexCostUSD(
      model,
      counts.inputTokens,
      counts.outputTokens,
      counts.cachedInputTokens ?? 0,
      usageDate,
    );
  }
  return undefined;
}

// Merge one provider-day record into the running accumulator for that day.
// Day cost prefers the stored totals.costUSD; falls back to the sum of per-model
// costs when totals are missing but at least one model had a (possibly
// backfilled) cost.
export function mergeProviderDay(
  rec: DayEntry,
  providerKey: string,
  pData: ProviderDay,
  date?: string,
): void {
  rec.inputTokens += pData.totals.inputTokens;
  rec.outputTokens += pData.totals.outputTokens;
  if (pData.totals.cachedInputTokens !== undefined) {
    rec.cachedInputTokens = (rec.cachedInputTokens ?? 0) + pData.totals.cachedInputTokens;
  }
  if (pData.totals.rawInputTokens !== undefined) {
    rec.rawInputTokens = (rec.rawInputTokens ?? 0) + pData.totals.rawInputTokens;
  }
  if (pData.totals.cacheCreationInputTokens !== undefined) {
    rec.cacheCreationInputTokens =
      (rec.cacheCreationInputTokens ?? 0) + pData.totals.cacheCreationInputTokens;
  }

  let summedModelCost = 0;
  let anyModelHadCost = false;
  for (const [model, counts] of Object.entries(pData.byModel)) {
    const m = (rec.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
    m.inputTokens += counts.inputTokens;
    m.outputTokens += counts.outputTokens;
    if (counts.cachedInputTokens !== undefined) {
      m.cachedInputTokens = (m.cachedInputTokens ?? 0) + counts.cachedInputTokens;
    }
    if (counts.rawInputTokens !== undefined) {
      m.rawInputTokens = (m.rawInputTokens ?? 0) + counts.rawInputTokens;
    }
    if (counts.cacheCreationInputTokens !== undefined) {
      m.cacheCreationInputTokens =
        (m.cacheCreationInputTokens ?? 0) + counts.cacheCreationInputTokens;
    }
    const cost = resolveModelCost(providerKey, model, counts, date);
    if (cost !== undefined) {
      m.costUSD = (m.costUSD ?? 0) + cost;
      summedModelCost += cost;
      anyModelHadCost = true;
    }
  }

  const dayCost = pData.totals.costUSD ?? (anyModelHadCost ? summedModelCost : undefined);
  if (dayCost !== undefined) rec.costUSD = (rec.costUSD ?? 0) + dayCost;
}

export interface LoadUsageOptions {
  noCursor?: boolean;
  year?: number;
}

export interface LoadedUsageData {
  providerData: ProviderData;
  machineData: MachineFile[];
  fileCount: number;
  warnedNotConfigured?: boolean;
}

export function emptyUsageMessage(warnedNotConfigured?: boolean): string {
  if (warnedNotConfigured) {
    return 'No local usage data found (Claude Code or Codex). Run: npx aitrack init to sync across machines.';
  }
  return 'No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally.';
}

function overlayMachineFile(providerData: ProviderData, machine: MachineFile): void {
  for (const [date, dayProviders] of Object.entries(machine.days)) {
    for (const [providerKey, pData] of Object.entries(dayProviders)) {
      if (providerKey === 'cursor') continue;
      const dayMap = (providerData[providerKey] ??= new Map());
      mergeProviderDay(getOrCreateDay(dayMap, date), providerKey, pData, date);
    }
  }
}

export async function loadMergedProviderData(
  opts: LoadUsageOptions = {},
): Promise<LoadedUsageData | null> {
  const config = tryLoadConfig();
  const machineId = config ? resolveMachineId(config) : hostname();
  const localMachine = await buildLocalMachineFile(machineId);
  writePendingMachineFile(localMachine);

  const warnedNotConfigured = !config || !isCloned();

  let machineData: MachineFile[] = [];
  let providerData: ProviderData = {};
  let fileCount = 0;

  if (config && isCloned()) {
    tryPull();

    const files = listDataFiles();
    fileCount = files.length;
    const currentFile = `${machineId}.json`;
    machineData = files
      .filter((f) => !f.endsWith(currentFile))
      .map(readDataFile)
      .filter((data): data is MachineFile => data !== null);
    providerData = splitByProvider(machineData);
  }

  if (machineHasData(localMachine)) {
    machineData.push(localMachine);
    overlayMachineFile(providerData, localMachine);
  }

  if (!opts.noCursor) {
    const cursorMap = await readCursorData();
    if (cursorMap.size > 0) providerData.cursor = cursorMap;
  }

  const filtered =
    opts.year === undefined ? providerData : filterProviderDataByYear(providerData, opts.year);

  if (Object.keys(filtered).length === 0) {
    return null;
  }

  return { providerData: filtered, machineData, fileCount, warnedNotConfigured };
}

function splitByProvider(machineFiles: MachineFile[]): ProviderData {
  const providers: ProviderData = {};
  for (const data of machineFiles) {
    for (const [date, providerData] of Object.entries(data.days)) {
      for (const [providerKey, pData] of Object.entries(providerData)) {
        // Cursor is never synced to git; merged locally in showCommand only.
        if (providerKey === 'cursor') continue;
        const dayMap = (providers[providerKey] ??= new Map());
        mergeProviderDay(getOrCreateDay(dayMap, date), providerKey, pData, date);
      }
    }
  }
  return providers;
}

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
  /** When true, do not read Cursor local state or call the dashboard CSV export. */
  noCursor?: boolean;
  /** Single merged heatmap; default is one row per provider. */
  all?: boolean;
  /** Commander sets this to false when --no-open is passed. Defaults to true. */
  open?: boolean;
  /** When set, only include days from this calendar year. */
  year?: number;
  /** Render a terminal table instead of a PNG heatmap. */
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

  const layoutData: ProviderData = opts.all
    ? { all: mergeAllProviderDayMaps(loaded.providerData) }
    : loaded.providerData;

  const outputPath = resolve(opts.output ?? 'aitrack.png');
  const png = renderToPng(layoutData, loaded.machineData, {
    dark: Boolean(opts.dark),
    all: Boolean(opts.all),
    year: opts.year,
  });
  writeFileSync(outputPath, png);

  console.log(`Saved: ${outputPath}`);
  if (opts.open !== false) openFile(outputPath);
}
