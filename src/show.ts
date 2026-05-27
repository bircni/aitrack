import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { exec } from 'child_process';
import { loadConfig } from './config.js';
import { isCloned, pull, listDataFiles, readDataFile } from './git.js';
import { readCursorData } from './readers/cursor.js';
import { estimateClaudeCostFromAggregateTokens } from './readers/claude.js';
import { estimateCodexCostUSD } from './pricing/codex.js';
import { renderToPng } from './render.js';
import type { DayEntry, MachineFile, ProviderData, ProviderDay, TokenCounts } from './types.js';
import { getOrCreateDay, filterProviderDataByYear } from './dayMap.js';

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

  let summedModelCost = 0;
  let anyModelHadCost = false;
  for (const [model, counts] of Object.entries(pData.byModel)) {
    const m = (rec.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
    m.inputTokens += counts.inputTokens;
    m.outputTokens += counts.outputTokens;
    if (counts.cachedInputTokens !== undefined) {
      m.cachedInputTokens = (m.cachedInputTokens ?? 0) + counts.cachedInputTokens;
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
}

export async function showCommand(opts: ShowOptions = {}): Promise<void> {
  loadConfig();

  if (!isCloned()) {
    throw new Error('Repo not cloned. Run: npx aitrack init');
  }

  console.log('Pulling latest from remote...');
  pull();

  const files = listDataFiles();
  const machineData = files
    .map(readDataFile)
    .filter((data): data is MachineFile => data !== null);
  const providerData = splitByProvider(machineData);

  if (!opts.noCursor) {
    const cursorMap = await readCursorData();
    if (cursorMap.size > 0) providerData.cursor = cursorMap;
  }

  const renderData =
    opts.year !== undefined ? filterProviderDataByYear(providerData, opts.year) : providerData;

  if (Object.keys(renderData).length === 0) {
    if (files.length === 0) {
      console.log(
        'No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally.',
      );
    } else {
      console.log('No usage data found.');
    }
    return;
  }

  const outputPath = resolve(opts.output ?? 'aitrack.png');
  const png = renderToPng(renderData, machineData, {
    dark: Boolean(opts.dark),
    all: Boolean(opts.all),
    year: opts.year,
  });
  writeFileSync(outputPath, png);

  console.log(`Saved: ${outputPath}`);
  if (opts.open !== false) openFile(outputPath);
}
