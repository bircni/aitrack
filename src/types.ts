export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /**
   * Subset of inputTokens that hit a cache (Codex prompt caching, Anthropic
   * cache_read). Billed at 10% of base input. When undefined, callers treat
   * the value as 0 — older synced data lacks this split.
   */
  cachedInputTokens?: number;
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

export interface Config {
  repoUrl: string;
}

export interface RenderOptions {
  dark?: boolean;
  /**
   * When false (default), one heatmap row per provider.
   * When true, a single merged heatmap across all providers.
   */
  all?: boolean;
}
