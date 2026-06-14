import { tryLoadConfig } from '../config.js';
import { orderedProviderKeys, providerLabel } from '../display/providers.js';
import { computeUsageWindow, type UsagePeriod } from '../display/usagePeriods.js';
import { isCloned } from '../git.js';
import { aggregateModelsByDayMap } from './aggregate.js';
import { emptyUsageMessage, loadMergedProviderData } from './usageData.js';

export interface UsageReportOptions {
  period: UsagePeriod;
  noCursor?: boolean;
  from?: string;
  to?: string;
  n?: number;
}

export interface UsageReportRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUSD: number;
  hasCost: boolean;
}

export interface UsageReportProvider {
  key: string;
  label: string;
  rows: UsageReportRow[];
  subtotalTokens: number;
  subtotalCostUSD: number;
  subtotalHasCost: boolean;
}

export interface UsageReportTotals {
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUSD: number;
  hasCost: boolean;
}

export interface UsageReport {
  windowLabel: string;
  providers: UsageReportProvider[];
  totals: UsageReportTotals;
  rowCount: number;
}

/**
 * Load merged provider data and build a structured per-provider / per-model
 * usage report for a time window. Returns null when no provider data is
 * available at all (caller should show the "not configured" hint); a report
 * with rowCount === 0 means data exists but nothing falls in the window.
 *
 * Shared by the `usage` (terminal table) and `export` (PDF receipt) commands so
 * both render from a single source of truth.
 */
export async function buildUsageReport(opts: UsageReportOptions): Promise<UsageReport | null> {
  const loaded = await loadMergedProviderData({ noCursor: opts.noCursor });
  if (!loaded) return null;

  const window = computeUsageWindow(opts);
  const ordered = orderedProviderKeys(loaded.providerData);

  const providers: UsageReportProvider[] = [];
  const totals: UsageReportTotals = {
    inputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    costUSD: 0,
    hasCost: false,
  };
  let rowCount = 0;

  for (const key of ordered) {
    const dayMap = loaded.providerData[key];
    if (!dayMap) continue;
    const byModel = aggregateModelsByDayMap(dayMap, { start: window.start, end: window.end });

    const rows: UsageReportRow[] = [];
    let subtotalTokens = 0;
    let subtotalCostUSD = 0;
    let subtotalHasCost = false;

    for (const [model, agg] of byModel) {
      const tokens = agg.inputTokens + agg.outputTokens;
      if (tokens === 0 && !agg.hasCost) continue;
      rows.push({
        model,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        tokens,
        costUSD: agg.hasCost ? agg.costUSD : 0,
        hasCost: agg.hasCost,
      });
      subtotalTokens += tokens;
      totals.inputTokens += agg.inputTokens;
      totals.outputTokens += agg.outputTokens;
      if (agg.hasCost) {
        subtotalCostUSD += agg.costUSD;
        subtotalHasCost = true;
        totals.costUSD += agg.costUSD;
        totals.hasCost = true;
      }
    }

    if (rows.length === 0) continue;
    rows.sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens);
    rowCount += rows.length;
    providers.push({
      key,
      label: providerLabel(key),
      rows,
      subtotalTokens,
      subtotalCostUSD,
      subtotalHasCost,
    });
  }

  totals.tokens = totals.inputTokens + totals.outputTokens;

  return { windowLabel: window.label, providers, totals, rowCount };
}

/**
 * Message to print when a report has nothing to render, or null when it does.
 * Distinguishes "no data at all / not configured" (report is null) from "data
 * exists but the window is empty" (rowCount === 0). Shared by the `usage` and
 * `export` commands so both report empty states identically.
 */
export function emptyReportMessage(report: UsageReport | null): string | null {
  if (!report) return emptyUsageMessage(!tryLoadConfig() || !isCloned());
  if (report.rowCount === 0) return `No usage recorded for ${report.windowLabel}.`;
  return null;
}
