/** Options shared by every renderer. */
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
