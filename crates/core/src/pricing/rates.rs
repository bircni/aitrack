use serde::{Deserialize, Serialize};

use crate::data::types::TokenCounts;

/// Cache reads bill at a tenth of the base input rate for every Codex model and most Claude ones.
pub const CACHE_READ_RATE_MULTIPLIER: f64 = 0.1;

/// Per-million-token rates for the four buckets Cursor and Claude bill separately.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullRates {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_write_per_million: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TokenBuckets {
    pub raw: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// Raw input is inferred from the total when a stored row has no explicit split.
#[expect(
    clippy::cast_precision_loss,
    reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
)]
#[must_use]
pub fn token_buckets(counts: &TokenCounts) -> TokenBuckets {
    let cache_read = counts.cached_input_tokens.unwrap_or(0);
    let cache_write = counts.cache_creation_input_tokens.unwrap_or(0);
    let one_hour = counts.cache_creation_1h_input_tokens.unwrap_or(0);
    let inferred =
        i128::from(counts.input_tokens) - i128::from(cache_read) - i128::from(cache_write) - i128::from(one_hour);
    TokenBuckets {
        raw: counts.raw_input_tokens.map_or(inferred.max(0) as f64, |raw| raw as f64),
        output: counts.output_tokens as f64,
        cache_read: cache_read as f64,
        cache_write: cache_write as f64,
    }
}

/// Term order is part of the result: sync commits on any change in the last bit.
#[must_use]
pub fn cost_from_rates(rates: &FullRates, tokens: &TokenBuckets) -> f64 {
    (tokens.raw * rates.input_per_million
        + tokens.output * rates.output_per_million
        + tokens.cache_read * rates.cache_read_per_million
        + tokens.cache_write * rates.cache_write_per_million)
        / 1_000_000.0
}

#[must_use]
pub fn scale_rates(rates: &FullRates, factor: f64) -> FullRates {
    FullRates {
        input_per_million: rates.input_per_million * factor,
        output_per_million: rates.output_per_million * factor,
        cache_read_per_million: rates.cache_read_per_million * factor,
        cache_write_per_million: rates.cache_write_per_million * factor,
    }
}
