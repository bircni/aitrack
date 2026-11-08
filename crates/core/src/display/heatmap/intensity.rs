use super::constants::INTENSITY_THRESHOLDS;

/// Nearest rank: `floor(p * (n - 1))` made the quieter of two days the ceiling.
#[must_use]
pub fn percentile(values: &[u64], p: f64) -> u64 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    #[expect(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        reason = "a fraction of a slice length fits i64, and the next line clamps it into the slice"
    )]
    let rank = (p * sorted.len() as f64).ceil() as i64 - 1;
    let index = usize::try_from(rank.max(0)).unwrap_or(0).min(sorted.len() - 1);
    sorted[index]
}

#[must_use]
pub fn token_intensity_level(tokens: u64, max: u64) -> u8 {
    #[expect(
        clippy::cast_precision_loss,
        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
    )]
    intensity_level(tokens as f64, max as f64)
}

/// A heatmap cell's level, 0 (nothing) to 4, from its share of the busiest cell.
#[must_use]
pub fn intensity_level(value: f64, max: f64) -> u8 {
    if value <= 0.0 || max <= 0.0 {
        return 0;
    }
    let ratio = (value / max).min(1.0);
    let [low, mid, high] = INTENSITY_THRESHOLDS;
    if ratio < low {
        1
    } else if ratio < mid {
        2
    } else if ratio < high {
        3
    } else {
        4
    }
}
