use indexmap::IndexMap;

use crate::data::types::{DayMap, TokenCounts};
use crate::day::Day;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub has_cost: bool,
    /// Days with any tokens.
    pub days: u64,
}

#[must_use]
pub fn sum_day_map(days: &DayMap) -> TokenTotals {
    let mut totals = TokenTotals::default();
    for day in days.values() {
        if day.counts.input_tokens + day.counts.output_tokens > 0 {
            totals.days += 1;
        }
        totals.input_tokens += day.counts.input_tokens;
        totals.output_tokens += day.counts.output_tokens;
        if let Some(cost) = day.counts.cost_usd {
            totals.cost_usd += cost;
            totals.has_cost = true;
        }
    }
    totals
}

#[must_use]
pub fn has_unpriced_usage(counts: &TokenCounts) -> bool {
    counts.has_unpriced_tokens == Some(true)
        || (counts.input_tokens + counts.output_tokens > 0 && counts.cost_usd.is_none())
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelAgg {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub has_cached: bool,
    pub cost_usd: f64,
    pub has_cost: bool,
    pub has_unpriced_tokens: bool,
    pub days: u64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DateFilter {
    pub start: Option<Day>,
    pub end: Option<Day>,
    pub year: Option<i16>,
}

#[must_use]
pub fn date_in_filter(date: Day, filter: &DateFilter) -> bool {
    filter.year.is_none_or(|y| date.year() == y)
        && filter.start.is_none_or(|s| date >= s)
        && filter.end.is_none_or(|e| date <= e)
}

/// Per-model sums over the days in `filter`, in first-seen order; rows with no tokens and no cost are skipped.
#[must_use]
pub fn aggregate_models(days: &DayMap, filter: &DateFilter) -> IndexMap<String, ModelAgg> {
    let mut by_model: IndexMap<String, ModelAgg> = IndexMap::new();
    for (date, day) in days {
        if !date_in_filter(*date, filter) {
            continue;
        }
        for (model, counts) in &day.by_model {
            if counts.input_tokens + counts.output_tokens == 0 && counts.cost_usd.is_none() {
                continue;
            }
            let agg = by_model.entry(model.clone()).or_default();
            agg.input_tokens += counts.input_tokens;
            agg.output_tokens += counts.output_tokens;
            if let Some(cached) = counts.cached_input_tokens {
                agg.cached_input_tokens += cached;
                agg.has_cached = true;
            }
            agg.days += 1;
            if has_unpriced_usage(counts) {
                agg.has_unpriced_tokens = true;
            }
            if let Some(cost) = counts.cost_usd {
                agg.cost_usd += cost;
                agg.has_cost = true;
            }
        }
    }
    by_model
}
