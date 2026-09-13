export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /**
   * Subset of inputTokens that hit a cache (Codex prompt caching, Anthropic
   * cache_read, Cursor "Cache Read"). Billed at the model's cache-read rate.
   * When undefined, callers treat the value as 0 — older synced data lacks
   * this split.
   */
  cachedInputTokens?: number;
  /** Uncached input (Claude input_tokens, Cursor "Input (w/o Cache Write)"). */
  rawInputTokens?: number;
  /** Cache writes (Claude cache_creation, Cursor "Input (w/ Cache Write)"). */
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface DayEntry extends TokenCounts {
  byModel: Record<string, TokenCounts>;
}

/** Map<dateStr "YYYY-MM-DD", DayEntry> */
export type DayMap = Map<string, DayEntry>;

/** { providerKey: DayMap } */
export type ProviderData = Record<string, DayMap>;

export interface ProviderDay {
  byModel: Record<string, TokenCounts>;
  totals: TokenCounts;
}

/** How the day keys in a machine file were bucketed. */
export type DayBucket = 'utc' | 'local';

export interface MachineFile {
  /** On-disk schema version. See src/data/schema.ts. */
  schemaVersion: number;
  hostname: string;
  /** IANA zone of the producing machine (Intl…resolvedOptions().timeZone). */
  timezone: string;
  /**
   * How the day keys were bucketed. Currently always 'local' (each machine's
   * own calendar day); the `timezone` field records which zone. 'utc' is
   * reserved for a future normalization.
   */
  dayBucket: DayBucket;
  lastUpdated: string;
  days: Record<string, Record<string, ProviderDay>>;
}
