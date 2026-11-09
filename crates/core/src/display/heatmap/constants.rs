/// Trailing weeks in the grid when no year is chosen.
pub const HEATMAP_WEEKS: i64 = 52;

/// Lookback for the "top recent model" figure.
pub const RECENT_WINDOW_DAYS: u64 = 30;

/// The intensity ceiling is this percentile of daily totals, so one huge spike cannot flatten the rest.
pub const INTENSITY_PERCENTILE: f64 = 0.9;

/// Fill ratios at which a cell moves up a level: below the first is level 1, at or past the last is level 4.
pub const INTENSITY_THRESHOLDS: [f64; 3] = [0.1, 0.35, 0.65];
