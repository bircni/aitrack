use super::constants::INTENSITY_THRESHOLDS;

/// Nearest rank: `floor(p * (n - 1))` made the quieter of two days the ceiling.
pub fn percentile(values: &[u64], p: f64) -> u64 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let rank = (p * sorted.len() as f64).ceil() as i64 - 1;
    let index = usize::try_from(rank.max(0)).unwrap_or(0).min(sorted.len() - 1);
    sorted[index]
}

pub fn token_intensity_level(tokens: u64, max: u64) -> u8 {
    #[allow(clippy::cast_precision_loss)]
    intensity_level(tokens as f64, max as f64)
}

/// A heatmap cell's level, 0 (nothing) to 4, from its share of the busiest cell.
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
