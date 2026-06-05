export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /**
   * Subset of inputTokens that hit a cache (Codex prompt caching, Anthropic
   * cache_read). Billed at 10% of base input. When undefined, callers treat
   * the value as 0 — older synced data lacks this split.
   */
  cachedInputTokens?: number;
  /** Claude: non-cache input_tokens only. Omitted in legacy synced data. */
  rawInputTokens?: number;
  /** Claude: cache_creation_input_tokens. Omitted in legacy synced data. */
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

export interface MachineFile {
  hostname: string;
  lastUpdated: string;
  days: Record<string, Record<string, ProviderDay>>;
}

interface DaemonConfig {
  /** When true, run sync (pull + push) on each daemon refresh tick. */
  sync?: boolean;
  /** HTTP listen port for the daemon dashboard. */
  port?: number;
  /** Seconds between data refresh ticks. */
  interval?: number;
}

export interface Config {
  repoUrl: string;
  /** Stable machine identifier for data/{machineId}.json; defaults to os.hostname(). */
  machineId?: string;
  daemon?: DaemonConfig;
}

export interface RenderOptions {
  dark?: boolean;
  /**
   * When false (default), one heatmap row per provider.
   * When true, a single merged heatmap across all providers.
   */
  all?: boolean;
  /** When set, only include days from this calendar year. */
  year?: number;
}
