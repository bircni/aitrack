//! Shared constants.

use regex::Regex;
use std::sync::LazyLock;

static DAY_KEY_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("day key regex"));

/// Cache reads bill at a tenth of the base input rate.
pub const CACHE_READ_RATE_MULTIPLIER: f64 = 0.1;

pub fn is_day_key(value: &str) -> bool {
    DAY_KEY_PATTERN.is_match(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_key_accepts_iso_dates() {
        assert!(is_day_key("2026-04-12"));
        assert!(!is_day_key("2026-4-12"));
        assert!(!is_day_key("not-a-date"));
    }
}
