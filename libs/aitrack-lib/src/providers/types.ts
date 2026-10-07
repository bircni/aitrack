import type { DayMap, TokenCounts } from '../data/types.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import type { CheckResult } from './checkResult.js';

export interface ProviderDescriptor {
  /** Canonical key, as used in the data files. */
  key: string;
  /** Human-readable name. */
  label: string;
  /** Friendly spellings accepted by `--providers`, lowercase. */
  aliases: readonly string[];
  /** Column heading for money. Estimates say "Est. cost"; billed values say "Cost". */
  costLabel: string;
}

/** Five-stop heatmap cell ramp, lightest (empty) to darkest (busiest). */
export type CellRamp = readonly [string, string, string, string, string];

export interface ProviderHeatmap {
  light: CellRamp;
  dark: CellRamp;
}

export type PriceMode = 'merge' | 'recompute';

export interface ProviderPricing {
  /**
   * Cost for one model's tokens on a given day, or undefined when the model
   * cannot be priced. Caller applies the merge/costUSD short-circuit.
   */
  priceModelCost: (
    model: string,
    counts: TokenCounts,
    usageDate: string | undefined,
    mode: PriceMode,
    fallbacks?: FallbackCollector,
  ) => number | undefined;
  /**
   * True when `recompute-costs` must leave a stored cost untouched for a row
   * that lacks a cache breakdown (Claude's older synced data). Default false.
   */
  repriceRequiresBreakdown?: boolean;
}

/** How a synced provider's data is read from local transcript files. */
export interface SyncedProviderReader {
  /** Full read: list sources, parse (cached), merge. */
  readData: (fallbacks?: FallbackCollector) => Promise<DayMap>;
}

/** A provider fetched live on every command and never written to git (Cursor). */
export interface LiveProviderReader {
  /**
   * Fetch usage, optionally from a local cache. `maxAgeSeconds === 0` forces a
   * network refresh; a larger value serves a cache younger than that.
   */
  liveFetch: (options?: { maxAgeSeconds?: number }) => Promise<DayMap>;
}

interface ProviderBase {
  descriptor: ProviderDescriptor;
  heatmap: ProviderHeatmap;
  pricing: ProviderPricing;
  doctorCheck: () => CheckResult | Promise<CheckResult>;
}

/** A provider read from local logs and written to git during sync. */
export interface SyncedProvider extends ProviderBase {
  reader: SyncedProviderReader;
  live?: undefined;
}

/** A provider fetched live on every command and never persisted (Cursor). */
export interface LiveProvider extends ProviderBase {
  live: LiveProviderReader;
  reader?: undefined;
}

/**
 * A union rather than one shape with two optional readers, so "synced ⇒ has a
 * reader" is a compile error instead of a runtime throw from inside the sync,
 * recompute and report paths.
 */
export type Provider = SyncedProvider | LiveProvider;
