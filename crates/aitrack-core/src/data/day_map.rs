//! Day map manipulation utilities.

use chrono::{Datelike, NaiveDate};

use super::types::{DayEntry, DayMap, ProviderData, TokenCounts};

pub fn get_or_create_day<'a>(day_map: &'a mut DayMap, date: &str) -> &'a mut DayEntry {
    day_map.entry(date.to_string()).or_default()
}

pub fn to_local_date_string(ts: &str) -> String {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
        let local = dt.with_timezone(&chrono::Local);
        return format!(
            "{:04}-{:02}-{:02}",
            local.year(),
            local.month(),
            local.day()
        );
    }

    // Try parsing as a simple date
    if let Ok(date) = NaiveDate::parse_from_str(ts, "%Y-%m-%d") {
        return format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day());
    }

    String::new()
}

/// Day key for a timestamp, or None when it cannot be parsed.
pub fn try_local_date_string(ts: &str) -> Option<String> {
    let result = to_local_date_string(ts);
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

/// Accumulate the optional cache/raw token breakdown fields.
fn merge_token_breakdown(dst: &mut TokenCounts, source: &TokenCounts) {
    if let Some(raw) = source.raw_input_tokens {
        *dst.raw_input_tokens.get_or_insert(0) += raw;
    }
    if let Some(cached) = source.cached_input_tokens {
        *dst.cached_input_tokens.get_or_insert(0) += cached;
    }
    if let Some(cache_create) = source.cache_creation_input_tokens {
        *dst.cache_creation_input_tokens.get_or_insert(0) += cache_create;
    }
}

/// Add source token fields onto dest (input, output, breakdown, cost).
pub fn add_token_counts(dest: &mut TokenCounts, source: &TokenCounts) {
    dest.input_tokens += source.input_tokens;
    dest.output_tokens += source.output_tokens;
    merge_token_breakdown(dest, source);
    if let Some(cost) = source.cost_usd {
        *dest.cost_usd.get_or_insert(0.0) += cost;
    }
}

/// Add one model's usage onto a day — the model row and the day totals.
pub fn add_model_usage(day: &mut DayEntry, model: &str, counts: &TokenCounts) {
    let rec = day.by_model.entry(model.to_string()).or_default();
    add_token_counts(rec, counts);

    // Add to day totals
    day.input_tokens += counts.input_tokens;
    day.output_tokens += counts.output_tokens;
    if let Some(raw) = counts.raw_input_tokens {
        *day.raw_input_tokens.get_or_insert(0) += raw;
    }
    if let Some(cached) = counts.cached_input_tokens {
        *day.cached_input_tokens.get_or_insert(0) += cached;
    }
    if let Some(cache_create) = counts.cache_creation_input_tokens {
        *day.cache_creation_input_tokens.get_or_insert(0) += cache_create;
    }
    if let Some(cost) = counts.cost_usd {
        *day.cost_usd.get_or_insert(0.0) += cost;
    }
}

/// Merge one DayMap into another, summing day totals, breakdowns and models.
pub fn merge_day_maps(dst: &mut DayMap, source: &DayMap) {
    for (date, source_day) in source {
        let dst_day = get_or_create_day(dst, date);

        // Merge day-level totals
        dst_day.input_tokens += source_day.input_tokens;
        dst_day.output_tokens += source_day.output_tokens;
        if let Some(raw) = source_day.raw_input_tokens {
            *dst_day.raw_input_tokens.get_or_insert(0) += raw;
        }
        if let Some(cached) = source_day.cached_input_tokens {
            *dst_day.cached_input_tokens.get_or_insert(0) += cached;
        }
        if let Some(cache_create) = source_day.cache_creation_input_tokens {
            *dst_day.cache_creation_input_tokens.get_or_insert(0) += cache_create;
        }
        if let Some(cost) = source_day.cost_usd {
            *dst_day.cost_usd.get_or_insert(0.0) += cost;
        }

        // Merge by-model data
        for (model, counts) in &source_day.by_model {
            let model_totals = dst_day.by_model.entry(model.clone()).or_default();
            add_token_counts(model_totals, counts);
        }
    }
}

pub fn filter_day_map_by_year(day_map: &DayMap, year: u32) -> DayMap {
    let prefix = format!("{}-", year);
    day_map
        .iter()
        .filter(|(date, _)| date.starts_with(&prefix))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

pub fn filter_provider_data_by_year(data: &ProviderData, year: u32) -> ProviderData {
    let mut filtered = ProviderData::new();
    for (provider_key, day_map) in data {
        let next = filter_day_map_by_year(day_map, year);
        if !next.is_empty() {
            filtered.insert(provider_key.clone(), next);
        }
    }
    filtered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_local_date_string() {
        // Should handle RFC3339 timestamps
        assert!(!to_local_date_string("2026-09-13T10:00:00Z").is_empty());
    }

    #[test]
    fn test_add_token_counts() {
        let mut dest = TokenCounts::new();
        let source = TokenCounts {
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: Some(0.5),
            ..Default::default()
        };

        add_token_counts(&mut dest, &source);
        assert_eq!(dest.input_tokens, 100);
        assert_eq!(dest.output_tokens, 50);
        assert_eq!(dest.cost_usd, Some(0.5));
    }
}
