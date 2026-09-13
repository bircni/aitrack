//! Sorting utilities for usage data.

use super::aggregate::ModelAgg;
use std::cmp::Ordering;

/// Compare two ModelAgg entries by cost (descending).
pub fn compare_by_cost(a: &ModelAgg, b: &ModelAgg) -> Ordering {
    b.cost_usd
        .partial_cmp(&a.cost_usd)
        .unwrap_or(Ordering::Equal)
}

/// Compare two ModelAgg entries by input tokens (descending).
pub fn compare_by_input(a: &ModelAgg, b: &ModelAgg) -> Ordering {
    b.input_tokens.cmp(&a.input_tokens)
}

/// Compare two ModelAgg entries by output tokens (descending).
pub fn compare_by_output(a: &ModelAgg, b: &ModelAgg) -> Ordering {
    b.output_tokens.cmp(&a.output_tokens)
}

/// Compare two ModelAgg entries by number of days (descending).
pub fn compare_by_days(a: &ModelAgg, b: &ModelAgg) -> Ordering {
    b.days.cmp(&a.days)
}
