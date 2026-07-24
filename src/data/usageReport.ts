import { orderedProviderKeys, providerLabel } from '../display/providers.js';
import {
  computePreviousUsageWindow,
  computeUsageWindow,
  type UsagePeriod,
  type UsageWindow,
} from '../display/usagePeriods.js';
import { aggregateModelsByDayMap } from './aggregate.js';
import { isUsageNotConfigured, usageEmptyMessage, usageEmptyWindowMessage } from './emptyState.js';
import { compareByCostThenTokens } from './sort.js';
import type { ProviderData } from './types.js';
import { loadMergedProviderData } from './usageData.js';

export interface UsageReportOptions {
  period: UsagePeriod;
  providers?: string[];
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

export interface UsageComparisonMetric {
  current: number;
  previous: number;
  delta: number;
  percentChange: number | null;
}

export interface UsageModelComparison {
  providerKey: string;
  providerLabel: string;
  model: string;
  tokens: UsageComparisonMetric;
  costUSD: UsageComparisonMetric;
  hasCost: boolean;
}

export interface UsageComparison {
  previousWindowLabel: string;
  totals: {
    tokens: UsageComparisonMetric;
    costUSD: UsageComparisonMetric;
    hasCost: boolean;
  };
  models: UsageModelComparison[];
}

export interface UsageComparisonReport {
  current: UsageReport;
  previous: UsageReport;
  comparison: UsageComparison;
}

function buildUsageReportFromData(providerData: ProviderData, window: UsageWindow): UsageReport {
  const ordered = orderedProviderKeys(providerData);
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
    const dayMap = providerData[key];
    if (!dayMap) continue;
    const byModel = aggregateModelsByDayMap(dayMap, { start: window.start, end: window.end });

    const rows: UsageReportRow[] = [];
    let subtotalTokens = 0;
    let subtotalCostUSD = 0;
    let isSubtotalHasCost = false;

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
        isSubtotalHasCost = true;
        totals.costUSD += agg.costUSD;
        totals.hasCost = true;
      }
    }

    if (rows.length === 0) continue;
    rows.sort((a, b) => compareByCostThenTokens(a, b));
    rowCount += rows.length;
    providers.push({
      key,
      label: providerLabel(key),
      rows,
      subtotalTokens,
      subtotalCostUSD,
      subtotalHasCost: isSubtotalHasCost,
    });
  }

  totals.tokens = totals.inputTokens + totals.outputTokens;
  return { windowLabel: window.label, providers, totals, rowCount };
}

function comparisonMetric(current: number, previous: number): UsageComparisonMetric {
  return {
    current,
    previous,
    delta: current - previous,
    percentChange: previous === 0 ? null : ((current - previous) / previous) * 100,
  };
}

function rowsByProviderAndModel(report: UsageReport): Map<string, UsageReportRow> {
  const rows = new Map<string, UsageReportRow>();
  for (const provider of report.providers) {
    for (const row of provider.rows) {
      rows.set(`${provider.key}\0${row.model}`, row);
    }
  }
  return rows;
}

function compareUsageReports(current: UsageReport, previous: UsageReport): UsageComparison {
  const currentRows = rowsByProviderAndModel(current);
  const previousRows = rowsByProviderAndModel(previous);
  const keys = new Set([...currentRows.keys(), ...previousRows.keys()]);
  const models: UsageModelComparison[] = [];

  for (const key of keys) {
    const separator = key.indexOf('\0');
    const providerKey = key.slice(0, separator);
    const model = key.slice(separator + 1);
    const currentRow = currentRows.get(key);
    const previousRow = previousRows.get(key);
    models.push({
      providerKey,
      providerLabel: providerLabel(providerKey),
      model,
      tokens: comparisonMetric(currentRow?.tokens ?? 0, previousRow?.tokens ?? 0),
      costUSD: comparisonMetric(currentRow?.costUSD ?? 0, previousRow?.costUSD ?? 0),
      hasCost: (currentRow?.hasCost ?? false) || (previousRow?.hasCost ?? false),
    });
  }

  models.sort((a, b) => {
    const costDifference = Math.abs(b.costUSD.delta) - Math.abs(a.costUSD.delta);
    if (costDifference !== 0) return costDifference;
    const tokenDifference = Math.abs(b.tokens.delta) - Math.abs(a.tokens.delta);
    if (tokenDifference !== 0) return tokenDifference;
    return `${a.providerKey}\0${a.model}`.localeCompare(`${b.providerKey}\0${b.model}`);
  });

  return {
    previousWindowLabel: previous.windowLabel,
    totals: {
      tokens: comparisonMetric(current.totals.tokens, previous.totals.tokens),
      costUSD: comparisonMetric(current.totals.costUSD, previous.totals.costUSD),
      hasCost: current.totals.hasCost || previous.totals.hasCost,
    },
    models,
  };
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
export async function buildUsageReport(options: UsageReportOptions): Promise<UsageReport | null> {
  const loaded = await loadMergedProviderData({ providers: options.providers });
  if (!loaded) return null;

  const window = computeUsageWindow(options);
  return buildUsageReportFromData(loaded.providerData, window);
}

export async function buildUsageComparison(
  options: UsageReportOptions,
): Promise<UsageComparisonReport | null> {
  const currentWindow = computeUsageWindow(options);
  const previousWindow = computePreviousUsageWindow(options, currentWindow);
  const loaded = await loadMergedProviderData({ providers: options.providers });
  if (!loaded) return null;

  const current = buildUsageReportFromData(loaded.providerData, currentWindow);
  const previous = buildUsageReportFromData(loaded.providerData, previousWindow);
  return { current, previous, comparison: compareUsageReports(current, previous) };
}

/**
 * Message to print when a report has nothing to render, or null when it does.
 * Distinguishes "no data at all / not configured" (report is null) from "data
 * exists but the window is empty" (rowCount === 0). Shared by the `usage` and
 * `export` commands so both report empty states identically.
 */
export function emptyReportMessage(report: UsageReport | null): string | null {
  if (!report) return usageEmptyMessage(isUsageNotConfigured());
  if (report.rowCount === 0) return usageEmptyWindowMessage(report.windowLabel);
  return null;
}
