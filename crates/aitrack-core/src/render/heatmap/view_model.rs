//! Heatmap view model with statistics.

use crate::calendar::shift_date;
use crate::data::aggregate::sum_day_map;
use crate::data::types::DayMap;
use crate::format::{fmt, fmt_usd_cost};
use crate::providers::{cost_column_label, provider_label};
use chrono::Datelike;
use std::collections::HashMap;

const INTENSITY_PERCENTILE: f64 = 0.9;
const RECENT_WINDOW_DAYS: i64 = 30;

#[derive(Debug, Clone)]
pub struct StatCell {
    pub label: String,
    pub value: String,
    pub sub: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderSectionViewModel {
    pub name: String,
    pub max_tokens: u64,
    pub header_stats: Vec<StatCell>,
    pub bottom_stats: Vec<StatCell>,
}

/// Calculate percentile from sorted values using nearest-rank method
pub fn percentile(mut sorted: Vec<u64>, p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    sorted.sort_unstable();
    let rank = ((p * sorted.len() as f64).ceil() as usize).saturating_sub(1);
    let index = rank.min(sorted.len() - 1);
    sorted.get(index).copied().unwrap_or(0)
}

/// Calculate intensity level (0-4) for a given token count relative to max
pub fn token_intensity_level(tokens: u64, max: u64) -> u8 {
    if tokens == 0 || max == 0 {
        return 0;
    }

    let ratio = ((tokens as f64) / (max as f64)).min(1.0);
    const THRESHOLDS: [f64; 3] = [0.1, 0.35, 0.65];

    if ratio < THRESHOLDS[0] {
        1
    } else if ratio < THRESHOLDS[1] {
        2
    } else if ratio < THRESHOLDS[2] {
        3
    } else {
        4
    }
}

#[derive(Debug, Clone)]
struct ProviderStats {
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    cost_usd: f64,
    has_cost: bool,
    current_streak: usize,
    longest_streak: usize,
    peak_month: Option<(String, u64)>,
}

fn provider_stats(day_map: &DayMap) -> ProviderStats {
    let totals = sum_day_map(day_map);

    ProviderStats {
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        total_tokens: totals.input_tokens + totals.output_tokens,
        cost_usd: totals.cost_usd,
        has_cost: totals.has_cost,
        current_streak: current_streak(day_map),
        longest_streak: longest_streak(day_map),
        peak_month: peak_month(day_map),
    }
}

fn has_activity(day_map: &DayMap, key: &str) -> bool {
    if let Some(v) = day_map.get(key) {
        v.input_tokens + v.output_tokens > 0
    } else {
        false
    }
}

fn current_streak(day_map: &DayMap) -> usize {
    let today = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let mut current_date = today.clone();

    // Start from yesterday if today has no activity
    if !has_activity(day_map, &current_date) {
        current_date = shift_date(&current_date, -1);
    }

    let mut streak = 0;
    while has_activity(day_map, &current_date) {
        streak += 1;
        current_date = shift_date(&current_date, -1);
    }
    streak
}

fn longest_streak(day_map: &DayMap) -> usize {
    let mut active_dates: Vec<String> = day_map
        .iter()
        .filter(|(_, v)| v.input_tokens + v.output_tokens > 0)
        .map(|(d, _)| d.clone())
        .collect();

    if active_dates.is_empty() {
        return 0;
    }

    active_dates.sort();

    let mut longest = 1;
    let mut current = 1;

    for i in 1..active_dates.len() {
        let prev_date = chrono::NaiveDate::parse_from_str(&active_dates[i - 1], "%Y-%m-%d").ok();
        let curr_date = chrono::NaiveDate::parse_from_str(&active_dates[i], "%Y-%m-%d").ok();

        if let (Some(prev), Some(curr)) = (prev_date, curr_date) {
            let diff_days = (curr - prev).num_days();
            if diff_days == 1 {
                current += 1;
                longest = longest.max(current);
            } else if diff_days > 1 {
                current = 1;
            }
        }
    }

    longest
}

fn peak_month(day_map: &DayMap) -> Option<(String, u64)> {
    let mut months = HashMap::new();

    for (date, day) in day_map {
        let total = day.input_tokens + day.output_tokens;
        if total == 0 {
            continue;
        }
        let month = &date[0..7]; // YYYY-MM
        *months.entry(month.to_string()).or_insert(0) += total;
    }

    months.into_iter().max_by_key(|(_, tokens)| *tokens)
}

#[derive(Debug, Clone)]
struct ModelTop {
    model: String,
    tokens: u64,
}

#[derive(Debug, Clone)]
struct PeakDay {
    date: String,
    tokens: u64,
}

#[derive(Debug, Clone)]
struct ModelStats {
    top_all_time: Option<ModelTop>,
    top_recent: Option<ModelTop>,
    peak: Option<PeakDay>,
}

fn recent_window_start() -> String {
    let d = chrono::Local::now().date_naive();
    let past = d - chrono::Duration::days(RECENT_WINDOW_DAYS);
    past.format("%Y-%m-%d").to_string()
}

fn compute_model_stats(day_map: &DayMap) -> ModelStats {
    let since = recent_window_start();
    let mut all_time = HashMap::new();
    let mut recent = HashMap::new();
    let mut top_all: Option<ModelTop> = None;
    let mut top_rec: Option<ModelTop> = None;
    let mut peak: Option<PeakDay> = None;

    for (date, data) in day_map {
        let day_total = data.input_tokens + data.output_tokens;
        if day_total > 0 && (peak.is_none() || day_total > peak.as_ref().unwrap().tokens) {
            peak = Some(PeakDay {
                date: date.clone(),
                tokens: day_total,
            });
        }

        let is_recent = date.as_str() >= since.as_str();

        for (model, counts) in &data.by_model {
            let tokens = counts.input_tokens + counts.output_tokens;
            if tokens == 0 {
                continue;
            }

            // Update all-time
            let all_total = all_time.entry(model.clone()).or_insert(0);
            *all_total += tokens;
            if top_all.is_none() || *all_total > top_all.as_ref().unwrap().tokens {
                top_all = Some(ModelTop {
                    model: model.clone(),
                    tokens: *all_total,
                });
            }

            // Update recent if applicable
            if is_recent {
                let rec_total = recent.entry(model.clone()).or_insert(0);
                *rec_total += tokens;
                if top_rec.is_none() || *rec_total > top_rec.as_ref().unwrap().tokens {
                    top_rec = Some(ModelTop {
                        model: model.clone(),
                        tokens: *rec_total,
                    });
                }
            }
        }
    }

    ModelStats {
        top_all_time: top_all,
        top_recent: top_rec,
        peak,
    }
}

fn format_peak_date(date: &str) -> String {
    if let Ok(d) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        const MONTHS: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let month = MONTHS
            .get((d.month() as usize).saturating_sub(1))
            .unwrap_or(&"");
        format!("{} {}, {}", month, d.day(), d.year())
    } else {
        date.to_string()
    }
}

fn format_month_label(month: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    let parts: Vec<&str> = month.split('-').collect();
    if parts.len() == 2 {
        if let Ok(m) = parts[1].parse::<usize>() {
            if m > 0 && m <= 12 {
                return format!("{} {}", MONTHS[m - 1], parts[0]);
            }
        }
    }
    month.to_string()
}

fn display_model_name(model: &str) -> String {
    // Simplify common model names for display
    model.replace("claude-", "").replace("gpt-", "")
}

pub fn build_provider_section_view_model(
    provider_key: &str,
    day_map: &DayMap,
) -> ProviderSectionViewModel {
    let stats = provider_stats(day_map);

    // Calculate max tokens for intensity percentile
    let day_totals: Vec<u64> = day_map
        .values()
        .map(|v| v.input_tokens + v.output_tokens)
        .filter(|&total| total > 0)
        .collect();

    let max_tokens = percentile(day_totals, INTENSITY_PERCENTILE).max(1);

    let cost_label = cost_column_label(provider_key, true);
    let cost_value = if stats.has_cost {
        fmt_usd_cost(stats.cost_usd)
    } else {
        "—".to_string()
    };

    let model_stats = compute_model_stats(day_map);

    let bottom_stats = vec![
        StatCell {
            label: "MOST USED MODEL".to_string(),
            value: model_stats
                .top_all_time
                .as_ref()
                .map(|t| display_model_name(&t.model))
                .unwrap_or_else(|| "—".to_string()),
            sub: model_stats.top_all_time.as_ref().map(|t| fmt(t.tokens)),
        },
        StatCell {
            label: "LAST 30 DAYS".to_string(),
            value: model_stats
                .top_recent
                .as_ref()
                .map(|t| display_model_name(&t.model))
                .unwrap_or_else(|| "—".to_string()),
            sub: model_stats.top_recent.as_ref().map(|t| fmt(t.tokens)),
        },
        StatCell {
            label: "PEAK DAY".to_string(),
            value: model_stats
                .peak
                .as_ref()
                .map(|p| format_peak_date(&p.date))
                .unwrap_or_else(|| "—".to_string()),
            sub: model_stats.peak.as_ref().map(|p| fmt(p.tokens)),
        },
        StatCell {
            label: "PEAK MONTH".to_string(),
            value: stats
                .peak_month
                .as_ref()
                .map(|(m, _)| format_month_label(m))
                .unwrap_or_else(|| "—".to_string()),
            sub: stats.peak_month.as_ref().map(|(_, t)| fmt(*t)),
        },
        StatCell {
            label: "CURRENT STREAK".to_string(),
            value: format!(
                "{} day{}",
                stats.current_streak,
                if stats.current_streak == 1 { "" } else { "s" }
            ),
            sub: None,
        },
        StatCell {
            label: "LONGEST STREAK".to_string(),
            value: format!(
                "{} day{}",
                stats.longest_streak,
                if stats.longest_streak == 1 { "" } else { "s" }
            ),
            sub: None,
        },
    ];

    let header_stats = vec![
        StatCell {
            label: "INPUT TOKENS".to_string(),
            value: fmt(stats.input_tokens),
            sub: None,
        },
        StatCell {
            label: "OUTPUT TOKENS".to_string(),
            value: fmt(stats.output_tokens),
            sub: None,
        },
        StatCell {
            label: "TOTAL TOKENS".to_string(),
            value: fmt(stats.total_tokens),
            sub: None,
        },
        StatCell {
            label: cost_label,
            value: cost_value,
            sub: None,
        },
    ];

    ProviderSectionViewModel {
        name: provider_label(provider_key),
        max_tokens,
        header_stats,
        bottom_stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::types::DayEntry;

    #[test]
    fn test_percentile() {
        let values = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        assert_eq!(percentile(values, 0.9), 9);
    }

    #[test]
    fn test_token_intensity_level() {
        assert_eq!(token_intensity_level(0, 100), 0);
        assert_eq!(token_intensity_level(5, 100), 1);
        assert_eq!(token_intensity_level(20, 100), 2);
        assert_eq!(token_intensity_level(50, 100), 3);
        assert_eq!(token_intensity_level(80, 100), 4);
    }

    #[test]
    fn test_build_provider_section_view_model() {
        let mut day_map = DayMap::new();
        let mut day1 = DayEntry::new();
        day1.input_tokens = 1000;
        day1.output_tokens = 500;
        day_map.insert("2026-01-01".to_string(), day1);

        let vm = build_provider_section_view_model("claude_code", &day_map);
        assert_eq!(vm.name, "Claude Code");
        assert!(vm.max_tokens > 0);
        assert!(!vm.header_stats.is_empty());
        assert!(!vm.bottom_stats.is_empty());
    }
}
