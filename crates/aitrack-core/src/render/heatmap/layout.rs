//! Heatmap layout and date grid generation.

use crate::calendar::{shift_date, year_of};
use crate::data::types::{DayMap, ProviderData};
use crate::providers::active_provider_keys;
use chrono::{Datelike, Local, NaiveDate};
use std::collections::HashMap;

pub const HEATMAP_WEEKS: i64 = 52;

pub struct ProviderLayoutOptions {
    pub all: bool,
    pub year: Option<u32>,
}

pub struct ProviderLayout {
    pub layout_data: HashMap<String, DayMap>,
    pub keys: Vec<String>,
}

/// Merge all provider day maps into one aggregated map
pub fn merge_all_provider_day_maps(provider_data: &ProviderData) -> DayMap {
    let mut result = DayMap::new();

    for day_map in provider_data.values() {
        for (date_key, day_entry) in day_map {
            let entry = result.entry(date_key.clone()).or_default();

            entry.input_tokens += day_entry.input_tokens;
            entry.output_tokens += day_entry.output_tokens;

            if let Some(cached) = day_entry.cached_input_tokens {
                let current = entry.cached_input_tokens.unwrap_or(0);
                entry.cached_input_tokens = Some(current + cached);
            }

            if let Some(raw) = day_entry.raw_input_tokens {
                let current = entry.raw_input_tokens.unwrap_or(0);
                entry.raw_input_tokens = Some(current + raw);
            }

            if let Some(cache_creation) = day_entry.cache_creation_input_tokens {
                let current = entry.cache_creation_input_tokens.unwrap_or(0);
                entry.cache_creation_input_tokens = Some(current + cache_creation);
            }

            if let Some(cost) = day_entry.cost_usd {
                let current = entry.cost_usd.unwrap_or(0.0);
                entry.cost_usd = Some(current + cost);
            }

            for (model, counts) in &day_entry.by_model {
                let model_entry = entry.by_model.entry(model.clone()).or_default();

                model_entry.input_tokens += counts.input_tokens;
                model_entry.output_tokens += counts.output_tokens;

                if let Some(cached) = counts.cached_input_tokens {
                    let current = model_entry.cached_input_tokens.unwrap_or(0);
                    model_entry.cached_input_tokens = Some(current + cached);
                }

                if let Some(raw) = counts.raw_input_tokens {
                    let current = model_entry.raw_input_tokens.unwrap_or(0);
                    model_entry.raw_input_tokens = Some(current + raw);
                }

                if let Some(cache_creation) = counts.cache_creation_input_tokens {
                    let current = model_entry.cache_creation_input_tokens.unwrap_or(0);
                    model_entry.cache_creation_input_tokens = Some(current + cache_creation);
                }

                if let Some(cost) = counts.cost_usd {
                    let current = model_entry.cost_usd.unwrap_or(0.0);
                    model_entry.cost_usd = Some(current + cost);
                }
            }
        }
    }

    result
}

/// Filter provider data by year
pub fn filter_provider_data_by_year(provider_data: &ProviderData, year: u32) -> ProviderData {
    let mut filtered = ProviderData::new();

    for (provider_key, day_map) in provider_data {
        let mut filtered_map = DayMap::new();

        for (date_key, day_entry) in day_map {
            if year_of(date_key) == year {
                filtered_map.insert(date_key.clone(), day_entry.clone());
            }
        }

        if !filtered_map.is_empty() {
            filtered.insert(provider_key.clone(), filtered_map);
        }
    }

    filtered
}

pub fn resolve_provider_layout(
    provider_data: &ProviderData,
    options: &ProviderLayoutOptions,
) -> ProviderLayout {
    let filtered = if let Some(year) = options.year {
        filter_provider_data_by_year(provider_data, year)
    } else {
        provider_data.clone()
    };

    if options.all {
        let merged = merge_all_provider_day_maps(&filtered);
        if merged.is_empty() {
            return ProviderLayout {
                layout_data: HashMap::new(),
                keys: Vec::new(),
            };
        }

        let mut layout_data = HashMap::new();
        layout_data.insert("all".to_string(), merged);

        return ProviderLayout {
            layout_data,
            keys: vec!["all".to_string()],
        };
    }

    ProviderLayout {
        layout_data: filtered.clone(),
        keys: active_provider_keys(&filtered),
    }
}

pub const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Build a date grid for the heatmap.
/// Returns a 2D array: weeks x days (7 per week).
/// None values represent padding cells.
pub fn build_date_grid(year: Option<u32>) -> Vec<Vec<Option<String>>> {
    if let Some(y) = year {
        build_year_grid(y)
    } else {
        build_trailing_weeks_grid()
    }
}

fn build_trailing_weeks_grid() -> Vec<Vec<Option<String>>> {
    let today = Local::now().date_naive();
    let today_str = today.format("%Y-%m-%d").to_string();

    // Start from the Sunday of (today - HEATMAP_WEEKS * 7) week
    let start_date_str = shift_date(&today_str, -HEATMAP_WEEKS * 7);
    let start_date = NaiveDate::parse_from_str(&start_date_str, "%Y-%m-%d").unwrap();

    // Align to Sunday
    let start_weekday = start_date.weekday().num_days_from_sunday();
    let aligned_start = if start_weekday == 0 {
        start_date
    } else {
        start_date - chrono::Duration::days(start_weekday as i64)
    };

    let mut weeks = Vec::new();
    let mut current = aligned_start;

    while current <= today {
        let mut week = Vec::new();
        for _ in 0..7 {
            if current <= today {
                week.push(Some(current.format("%Y-%m-%d").to_string()));
            } else {
                week.push(None);
            }
            current = current.succ_opt().unwrap();
        }
        weeks.push(week);
    }

    weeks
}

fn build_year_grid(year: u32) -> Vec<Vec<Option<String>>> {
    let today = Local::now().date_naive();
    let start = NaiveDate::from_ymd_opt(year as i32, 1, 1).unwrap();
    let end = if year == today.year() as u32 {
        today
    } else {
        NaiveDate::from_ymd_opt(year as i32, 12, 31).unwrap()
    };

    // Align start to Sunday
    let start_weekday = start.weekday().num_days_from_sunday();
    let aligned_start = if start_weekday == 0 {
        start
    } else {
        start - chrono::Duration::days(start_weekday as i64)
    };

    let mut weeks = Vec::new();
    let mut current = aligned_start;

    loop {
        let mut week = Vec::new();
        for _ in 0..7 {
            if current <= end && current.year() == year as i32 {
                week.push(Some(current.format("%Y-%m-%d").to_string()));
            } else {
                week.push(None);
            }
            current = current.succ_opt().unwrap();
        }
        weeks.push(week);

        if current > end && current.weekday().num_days_from_sunday() == 0 {
            break;
        }
    }

    weeks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_date_grid() {
        let grid = build_date_grid(None);
        assert!(!grid.is_empty());
        assert_eq!(grid[0].len(), 7); // 7 days per week
    }

    #[test]
    fn test_build_year_grid() {
        let grid = build_year_grid(2026);
        assert!(!grid.is_empty());
        assert_eq!(grid[0].len(), 7);
    }

    #[test]
    fn test_merge_all_provider_day_maps() {
        let mut provider_data = ProviderData::new();
        let mut day_map1 = DayMap::new();
        let mut entry1 = crate::data::types::DayEntry::new();
        entry1.input_tokens = 100;
        entry1.output_tokens = 50;
        day_map1.insert("2026-01-01".to_string(), entry1);
        provider_data.insert("claude_code".to_string(), day_map1);

        let merged = merge_all_provider_day_maps(&provider_data);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged.get("2026-01-01").unwrap().input_tokens, 100);
    }
}
