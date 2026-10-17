import { isAbsolute, relative } from 'node:path';

import { isSyncedProvider, providerLabel } from '../providers/index.js';
import { type AggregateModelsFilter, dateInFilter, hasUnpricedUsage } from './aggregate.js';
import { addTokenCounts, flagUnpriced } from './dayMap.js';
import { ALL_MODELS, type ProjectSelector, UNATTRIBUTED_PROJECT } from './project.js';
import { compareByCostThenTokens } from './sort.js';
import type { DayEntry, DayMap, ProviderData, TokenCounts } from './types.js';

interface ProjectProviderUsage {
  key: string;
  label: string;
  tokens: number;
  costUSD: number;
  hasCost: boolean;
  hasUnpricedTokens?: boolean;
}

export interface ProjectUsage {
  project: string;
  tokens: number;
  costUSD: number;
  hasCost: boolean;
  hasUnpricedTokens?: boolean;
  /** The remainder of days that carry no (or only partial) project split. */
  unattributed?: boolean;
  providers: ProjectProviderUsage[];
}

export interface ProjectBreakdown {
  projects: ProjectUsage[];
  /** Tokens synced before projects were recorded, and anything the split does not cover. */
  unattributed?: ProjectUsage;
}

interface Totals {
  tokens: number;
  costUSD: number;
  hasCost: boolean;
  hasUnpricedTokens: boolean;
}

interface Accumulator extends Totals {
  providers: Map<string, Totals>;
}

function addTotals(totals: Totals, counts: TokenCounts): void {
  totals.tokens += counts.inputTokens + counts.outputTokens;
  if (counts.costUSD !== undefined) {
    totals.costUSD += counts.costUSD;
    totals.hasCost = true;
  }
  if (hasUnpricedUsage(counts)) totals.hasUnpricedTokens = true;
}

function emptyTotals(): Totals {
  return { tokens: 0, costUSD: 0, hasCost: false, hasUnpricedTokens: false };
}

function accumulate(
  accumulators: Map<string, Accumulator>,
  project: string,
  providerKey: string,
  counts: TokenCounts,
): void {
  if (counts.inputTokens + counts.outputTokens === 0 && counts.costUSD === undefined) return;
  let accumulator = accumulators.get(project);
  if (!accumulator) {
    accumulator = { ...emptyTotals(), providers: new Map() };
    accumulators.set(project, accumulator);
  }
  addTotals(accumulator, counts);
  let provider = accumulator.providers.get(providerKey);
  if (!provider) {
    provider = emptyTotals();
    accumulator.providers.set(providerKey, provider);
  }
  addTotals(provider, counts);
}

function flag(totals: Totals): { hasUnpricedTokens?: true } {
  return totals.hasUnpricedTokens ? { hasUnpricedTokens: true } : {};
}

function toUsage(project: string, accumulator: Accumulator): ProjectUsage {
  return {
    project,
    tokens: accumulator.tokens,
    costUSD: accumulator.costUSD,
    hasCost: accumulator.hasCost,
    ...flag(accumulator),
    providers: [...accumulator.providers]
      .map(([key, totals]) => ({
        key,
        label: providerLabel(key),
        tokens: totals.tokens,
        costUSD: totals.costUSD,
        hasCost: totals.hasCost,
        ...flag(totals),
      }))
      .toSorted(compareByCostThenTokens),
  };
}

/** What the day's project split leaves unexplained, as counts to attribute to nobody. */
function remainder(day: DayEntry, attributed: TokenCounts): TokenCounts | null {
  const tokens =
    day.inputTokens + day.outputTokens - (attributed.inputTokens + attributed.outputTokens);
  if (tokens <= 0) return null;
  return {
    inputTokens: tokens,
    outputTokens: 0,
    ...(day.costUSD !== undefined && {
      costUSD: Math.max(0, day.costUSD - (attributed.costUSD ?? 0)),
    }),
    ...(day.hasUnpricedTokens && !attributed.hasUnpricedTokens && { hasUnpricedTokens: true }),
  };
}

/**
 * Usage per project over the days in `filter`, for the synced providers (Cursor
 * has no project data). Each day's projects plus its remainder add up to the
 * day's total, so these rows always sum to the usage report.
 */
export function aggregateProjects(
  providerData: ProviderData,
  filter?: AggregateModelsFilter,
): ProjectBreakdown {
  const accumulators = new Map<string, Accumulator>();
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    if (!isSyncedProvider(providerKey)) continue;
    for (const [date, day] of dayMap) {
      if (!dateInFilter(date, filter)) continue;
      const attributed: TokenCounts = { inputTokens: 0, outputTokens: 0 };
      for (const [project, counts] of Object.entries(day.byProject ?? {})) {
        accumulate(accumulators, project, providerKey, counts);
        addTokenCounts(attributed, counts);
      }
      const rest = remainder(day, attributed);
      if (rest) accumulate(accumulators, UNATTRIBUTED_PROJECT, providerKey, flagUnpriced(rest));
    }
  }

  const unattributed = accumulators.get(UNATTRIBUTED_PROJECT);
  accumulators.delete(UNATTRIBUTED_PROJECT);
  return {
    projects: [...accumulators]
      .map(([project, accumulator]) => toUsage(project, accumulator))
      .toSorted(compareByCostThenTokens),
    ...(unattributed && {
      unattributed: { ...toUsage(UNATTRIBUTED_PROJECT, unattributed), unattributed: true },
    }),
  };
}

function dirContains(dir: string, cwd: string): boolean {
  const path = relative(dir, cwd);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function sliceOf(day: DayEntry, selector: ProjectSelector): TokenCounts | undefined {
  if (selector.kind === 'project') return day.byProject?.[selector.project];
  const inside = Object.entries(day.byCwd ?? {}).filter(([cwd]) => dirContains(selector.dir, cwd));
  if (inside.length === 0) return undefined;
  const sum: TokenCounts = { inputTokens: 0, outputTokens: 0 };
  for (const [, counts] of inside) addTokenCounts(sum, counts);
  return sum;
}

/** Each day reduced to one project's share, as a single model row because the split has no models. */
export function projectProviderData(
  providerData: ProviderData,
  selector: ProjectSelector,
): ProviderData {
  const scoped: ProviderData = {};
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    if (!isSyncedProvider(providerKey)) continue;
    const days: DayMap = new Map();
    for (const [date, day] of dayMap) {
      const slice = sliceOf(day, selector);
      if (slice) days.set(date, { ...slice, byModel: { [ALL_MODELS]: slice } });
    }
    if (days.size > 0) scoped[providerKey] = days;
  }
  return scoped;
}
