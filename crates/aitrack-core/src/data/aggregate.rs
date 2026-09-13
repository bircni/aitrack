//! Aggregation functions for usage data.

use super::types::DayMap;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub has_cost: bool,
    pub days: usize,
}

pub fn sum_day_map(day_map: &DayMap) -> TokenTotals {
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut cost_usd = 0.0;
    let mut has_cost = false;
    let mut days = 0;

    for day in day_map.values() {
        if day.input_tokens + day.output_tokens > 0 {
            days += 1;
        }
        input_tokens += day.input_tokens;
        output_tokens += day.output_tokens;
        if let Some(cost) = day.cost_usd {
            cost_usd += cost;
            has_cost = true;
        }
    }

    TokenTotals {
        input_tokens,
        output_tokens,
        cost_usd,
        has_cost,
        days,
    }
}

#[derive(Debug, Clone)]
pub struct ModelAgg {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub has_cached: bool,
    pub cost_usd: f64,
    pub has_cost: bool,
    pub days: usize,
}

#[derive(Debug, Clone)]
pub struct AggregateModelsFilter {
    pub start: Option<String>,
    pub end: Option<String>,
    pub year: Option<u32>,
}

pub fn date_in_filter(date: &str, filter: Option<&AggregateModelsFilter>) -> bool {
    let Some(filter) = filter else {
        return true;
    };

    if let Some(year) = filter.year {
        let prefix = format!("{}-", year);
        if !date.starts_with(&prefix) {
            return false;
        }
    }

    if let Some(ref start) = filter.start {
        if date < start.as_str() {
            return false;
        }
    }

    if let Some(ref end) = filter.end {
        if date > end.as_str() {
            return false;
        }
    }

    true
}

pub fn aggregate_models_by_day_map(
    day_map: &DayMap,
    filter: Option<&AggregateModelsFilter>,
) -> HashMap<String, ModelAgg> {
    let mut by_model = HashMap::new();

    for (date, day) in day_map {
        if !date_in_filter(date, filter) {
            continue;
        }

        for (model, counts) in &day.by_model {
            let tokens = counts.input_tokens + counts.output_tokens;
            if tokens == 0 && counts.cost_usd.is_none() {
                continue;
            }

            let agg = by_model.entry(model.clone()).or_insert(ModelAgg {
                input_tokens: 0,
                output_tokens: 0,
                cached_input_tokens: 0,
                has_cached: false,
                cost_usd: 0.0,
                has_cost: false,
                days: 0,
            });

            agg.input_tokens += counts.input_tokens;
            agg.output_tokens += counts.output_tokens;
            if let Some(cached) = counts.cached_input_tokens {
                agg.cached_input_tokens += cached;
                agg.has_cached = true;
            }
            agg.days += 1;
            if let Some(cost) = counts.cost_usd {
                agg.cost_usd += cost;
                agg.has_cost = true;
            }
        }
    }

    by_model
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::types::DayEntry;

    #[test]
    fn test_sum_day_map() {
        let mut day_map = DayMap::new();
        let mut day1 = DayEntry::new();
        day1.input_tokens = 100;
        day1.output_tokens = 50;
        day1.cost_usd = Some(0.5);
        day_map.insert("2026-01-01".to_string(), day1);

        let totals = sum_day_map(&day_map);
        assert_eq!(totals.input_tokens, 100);
        assert_eq!(totals.output_tokens, 50);
        assert_eq!(totals.cost_usd, 0.5);
        assert!(totals.has_cost);
        assert_eq!(totals.days, 1);
    }

    #[test]
    fn test_date_in_filter() {
        let filter = AggregateModelsFilter {
            start: Some("2026-01-01".to_string()),
            end: Some("2026-12-31".to_string()),
            year: None,
        };

        assert!(date_in_filter("2026-06-15", Some(&filter)));
        assert!(!date_in_filter("2025-12-31", Some(&filter)));
        assert!(!date_in_filter("2027-01-01", Some(&filter)));
    }
}
