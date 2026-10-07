import { warnAboutPricingFallbacks } from '../pricing/scan.js';
import { orderedProviderKeys, providerLabel } from '../providers/index.js';
import { calendarDateInTimeZone, machineTimezone, UNKNOWN_TIMEZONE } from '../timezone.js';
import { aggregateModelsByDayMap } from './aggregate.js';
import { toLocalDateString } from './dayMap.js';
import { isUsageNotConfigured, usageEmptyMessage, usageEmptyWindowMessage } from './emptyState.js';
import { compareByCostThenTokens } from './sort.js';
import type { ProviderData } from './types.js';
import {
  type LoadedUsageData,
  loadMergedProviderData,
  providerDataForWindows,
  type ZonedUsageSource,
} from './usageData.js';
import {
  computePreviousUsageWindow,
  computeUsageWindow,
  periodAnchorsOnToday,
  type UsagePeriod,
  type UsageWindow,
  type UsageWindowOptions,
} from './usagePeriods.js';

export interface UsageReportOptions extends UsageWindowOptions {
  providers?: string[];
  /** Re-fetch live-provider (Cursor) data instead of serving a cached export. */
  refreshLive?: boolean;
}

export interface UsageReportRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  /** Subset of inputTokens that hit a prompt cache. */
  cachedInputTokens: number;
  hasCached: boolean;
  costUSD: number;
  hasCost: boolean;
  hasUnpricedTokens?: boolean;
}

export interface UsageReportProvider {
  key: string;
  label: string;
  rows: UsageReportRow[];
  subtotalTokens: number;
  subtotalCostUSD: number;
  subtotalHasCost: boolean;
  hasUnpricedTokens?: boolean;
}

export interface UsageReportTotals {
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cachedInputTokens: number;
  hasCached: boolean;
  costUSD: number;
  hasCost: boolean;
  hasUnpricedTokens?: boolean;
}

export interface UsageReport {
  windowLabel: string;
  providers: UsageReportProvider[];
  totals: UsageReportTotals;
  rowCount: number;
  /** Set when a relative window was evaluated in more than one timezone. */
  timezoneNote?: string;
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
  hasUnpricedTokens?: boolean;
}

export interface UsageComparison {
  previousWindowLabel: string;
  totals: {
    tokens: UsageComparisonMetric;
    costUSD: UsageComparisonMetric;
    hasCost: boolean;
    hasUnpricedTokens?: boolean;
  };
  models: UsageModelComparison[];
}

export interface UsageComparisonReport {
  current: UsageReport;
  previous: UsageReport;
  comparison: UsageComparison;
}

function viewerToday(now: Date): string {
  return calendarDateInTimeZone(machineTimezone(), now) ?? toLocalDateString(now);
}

function todayForZone(timezone: string, now: Date): string {
  return calendarDateInTimeZone(timezone, now) ?? viewerToday(now);
}

/** The viewer's zone, then every other recorded machine zone; empty when there are no others. */
export function machineZones(
  sources: ReadonlyArray<Pick<ZonedUsageSource, 'timezone'>> | undefined,
): string[] {
  const viewer = machineTimezone();
  const others = new Set(
    (sources ?? [])
      .map((source) => source.timezone)
      .filter(
        (timezone) => timezone !== '' && timezone !== UNKNOWN_TIMEZONE && timezone !== viewer,
      ),
  );
  return others.size === 0 ? [] : [viewer, ...others];
}

/** Other machines' zones, when a relative window has to follow more than one. */
export function timezoneWindowNote(
  sources: ZonedUsageSource[] | undefined,
  period: UsagePeriod,
): string | undefined {
  if (!sources || !periodAnchorsOnToday(period)) return undefined;
  const zones = machineZones(sources);
  if (zones.length === 0) return undefined;
  return `This window follows each machine's own timezone (${zones.join(', ')}).`;
}

function withTimezoneNote(
  report: UsageReport,
  sources: ZonedUsageSource[] | undefined,
  period: UsagePeriod,
): UsageReport {
  const timezoneNote = timezoneWindowNote(sources, period);
  return timezoneNote === undefined ? report : { ...report, timezoneNote };
}

export function emptyUsageTotals(): UsageReportTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    cachedInputTokens: 0,
    hasCached: false,
    costUSD: 0,
    hasCost: false,
  };
}

function windowedProviderData(
  loaded: LoadedUsageData,
  options: UsageReportOptions,
  kind: 'current' | 'previous',
  now: Date,
): { providerData: ProviderData; window: UsageWindow } {
  const labelToday = viewerToday(now);
  const labelWindow =
    kind === 'current'
      ? computeUsageWindow(options, labelToday, now)
      : computePreviousUsageWindow(
          options,
          computeUsageWindow(options, labelToday, now),
          labelToday,
        );
  if (!loaded.zonedSources) return { providerData: loaded.providerData, window: labelWindow };

  const providerData = providerDataForWindows(loaded, (timezone) => {
    const today = todayForZone(timezone, now);
    const current = computeUsageWindow(options, today, now);
    return kind === 'current' ? current : computePreviousUsageWindow(options, current, today);
  });
  // Already clipped per zone, so the label window must not clip again.
  return {
    providerData,
    window: { start: '0000-01-01', end: '9999-12-31', label: labelWindow.label },
  };
}

function buildUsageReportFromData(providerData: ProviderData, window: UsageWindow): UsageReport {
  const ordered = orderedProviderKeys(providerData);
  const providers: UsageReportProvider[] = [];
  const totals = emptyUsageTotals();
  let rowCount = 0;

  for (const key of ordered) {
    const dayMap = providerData[key];
    if (!dayMap) continue;
    const byModel = aggregateModelsByDayMap(dayMap, { start: window.start, end: window.end });

    const rows: UsageReportRow[] = [];
    let subtotalTokens = 0;
    let subtotalCostUSD = 0;
    let isSubtotalHasCost = false;
    let hasUnpricedTokens = false;

    for (const [model, agg] of byModel) {
      const tokens = agg.inputTokens + agg.outputTokens;
      rows.push({
        model,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        tokens,
        cachedInputTokens: agg.cachedInputTokens,
        hasCached: agg.hasCached,
        costUSD: agg.hasCost ? agg.costUSD : 0,
        hasCost: agg.hasCost,
        ...(agg.hasUnpricedTokens && { hasUnpricedTokens: true }),
      });
      hasUnpricedTokens ||= agg.hasUnpricedTokens === true;
      subtotalTokens += tokens;
      totals.inputTokens += agg.inputTokens;
      totals.outputTokens += agg.outputTokens;
      if (agg.hasCached) {
        totals.cachedInputTokens += agg.cachedInputTokens;
        totals.hasCached = true;
      }
      if (agg.hasCost) {
        subtotalCostUSD += agg.costUSD;
        isSubtotalHasCost = true;
        totals.costUSD += agg.costUSD;
        totals.hasCost = true;
      }
    }

    if (hasUnpricedTokens) totals.hasUnpricedTokens = true;
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
      ...(hasUnpricedTokens && { hasUnpricedTokens: true }),
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
      ...((currentRow?.hasUnpricedTokens === true || previousRow?.hasUnpricedTokens === true) && {
        hasUnpricedTokens: true,
      }),
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
      ...((current.totals.hasUnpricedTokens === true ||
        previous.totals.hasUnpricedTokens === true) && { hasUnpricedTokens: true }),
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
export async function buildUsageReport(
  options: UsageReportOptions,
  now = new Date(),
): Promise<UsageReport | null> {
  const loaded = await loadMergedProviderData({
    providers: options.providers,
    refreshLive: options.refreshLive,
  });
  if (!loaded) return null;

  warnAboutPricingFallbacks(loaded.providerData);
  return buildUsageReportFromLoaded(loaded, options, now);
}

/** One window's report from data already loaded, so several windows share one read. */
export function buildUsageReportFromLoaded(
  loaded: LoadedUsageData,
  options: UsageReportOptions,
  now = new Date(),
): UsageReport {
  const { providerData, window } = windowedProviderData(loaded, options, 'current', now);
  return withTimezoneNote(
    buildUsageReportFromData(providerData, window),
    loaded.zonedSources,
    options.period,
  );
}

/**
 * Several windows' reports from one load. When every source's calendar is on
 * the viewer's date, each window is the same for every source, so one merge
 * over their combined span serves all of them.
 */
export function buildUsageReportsFromLoaded(
  loaded: LoadedUsageData,
  optionsList: UsageReportOptions[],
  now = new Date(),
): UsageReport[] {
  const { zonedSources } = loaded;
  const labelToday = viewerToday(now);
  const zones = new Set([
    machineTimezone(),
    ...(zonedSources ?? []).map((source) => source.timezone),
  ]);
  if (
    optionsList.length === 0 ||
    (zonedSources && [...zones].some((timezone) => todayForZone(timezone, now) !== labelToday))
  ) {
    return optionsList.map((options) => buildUsageReportFromLoaded(loaded, options, now));
  }

  const windowed = optionsList.map((options) => ({
    options,
    window: computeUsageWindow(options, labelToday, now),
  }));
  const span = {
    start: windowed.reduce(
      (min, { window }) => (window.start < min ? window.start : min),
      '9999-12-31',
    ),
    end: windowed.reduce((max, { window }) => (window.end > max ? window.end : max), '0000-01-01'),
  };
  const providerData = providerDataForWindows(loaded, () => span);
  return windowed.map(({ options, window }) =>
    withTimezoneNote(buildUsageReportFromData(providerData, window), zonedSources, options.period),
  );
}

export async function buildUsageComparison(
  options: UsageReportOptions,
  now = new Date(),
): Promise<UsageComparisonReport | null> {
  const loaded = await loadMergedProviderData({
    providers: options.providers,
    refreshLive: options.refreshLive,
  });
  if (!loaded) return null;

  warnAboutPricingFallbacks(loaded.providerData);
  const currentWindow = windowedProviderData(loaded, options, 'current', now);
  const previousWindow = windowedProviderData(loaded, options, 'previous', now);
  const current = withTimezoneNote(
    buildUsageReportFromData(currentWindow.providerData, currentWindow.window),
    loaded.zonedSources,
    options.period,
  );
  const previous = buildUsageReportFromData(previousWindow.providerData, previousWindow.window);
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
