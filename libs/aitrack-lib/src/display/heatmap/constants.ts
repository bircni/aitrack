/** Milliseconds in one day — used for day-distance arithmetic between dates. */
export const MS_PER_DAY = 86_400_000;

/** Number of trailing weeks shown in the default (non-year) heatmap grid. */
export const HEATMAP_WEEKS = 52;

/** Lookback window (in days) for the "top recent model" statistic. */
export const RECENT_WINDOW_DAYS = 30;

/**
 * Percentile of daily token totals used as the heatmap's intensity ceiling.
 * Anchoring to the 90th percentile keeps a single huge spike from flattening
 * the rest of the graph.
 */
export const INTENSITY_PERCENTILE = 0.9;

/**
 * Ascending fill ratios (tokens / ceiling) at which a cell moves up an
 * intensity level. A ratio below the first entry is level 1; reaching/passing
 * the last entry is the max level 4.
 */
export const INTENSITY_THRESHOLDS = [0.1, 0.35, 0.65] as const;
