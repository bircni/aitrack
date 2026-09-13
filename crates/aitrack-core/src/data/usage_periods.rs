//! Usage period definitions and window calculations.

use crate::calendar::{
    inclusive_day_count, monday_of_week, same_day_in_year, shift_date, shift_month_end,
    shift_month_start, year_of,
};
use chrono::{Datelike, Local};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsagePeriod {
    Today,
    Yesterday,
    Week,
    Month,
    Year,
    All,
    ThisWeek,
    LastWeek,
    ThisMonth,
    LastMonth,
    Date,
    Range,
    Last,
}

#[derive(Debug, Clone)]
pub struct UsageWindow {
    pub start: String,
    pub end: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct UsageWindowOptions {
    pub period: UsagePeriod,
    pub from: Option<String>,
    pub to: Option<String>,
    pub n: Option<usize>,
}

fn today_string() -> String {
    let now = Local::now();
    format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day())
}

fn rolling_window(today: &str, n: i64) -> UsageWindow {
    let start = shift_date(today, -(n - 1));
    UsageWindow {
        start: start.clone(),
        end: today.to_string(),
        label: format!("last {} days ({} → {})", n, start, today),
    }
}

pub fn compute_usage_window(options: &UsageWindowOptions) -> UsageWindow {
    let today = today_string();

    match options.period {
        UsagePeriod::Today => {
            let now = Local::now();
            UsageWindow {
                start: today.clone(),
                end: today.clone(),
                label: format!(
                    "today ({} {})",
                    now.format("%Y-%m-%d"),
                    now.format("%H:%M:%S")
                ),
            }
        }
        UsagePeriod::Yesterday => {
            let date = shift_date(&today, -1);
            UsageWindow {
                start: date.clone(),
                end: date.clone(),
                label: format!("yesterday ({})", date),
            }
        }
        UsagePeriod::Date => {
            let from = options
                .from
                .as_ref()
                .expect("from required for date period");
            UsageWindow {
                start: from.clone(),
                end: from.clone(),
                label: from.clone(),
            }
        }
        UsagePeriod::Range => {
            let from = options.from.as_ref().expect("from required for range");
            let to = options.to.as_ref().expect("to required for range");
            UsageWindow {
                start: from.clone(),
                end: to.clone(),
                label: format!("{} → {}", from, to),
            }
        }
        UsagePeriod::ThisWeek => {
            let start = monday_of_week(&today);
            UsageWindow {
                start: start.clone(),
                end: today.clone(),
                label: format!("this week ({} → {})", start, today),
            }
        }
        UsagePeriod::LastWeek => {
            let monday = monday_of_week(&today);
            let start = shift_date(&monday, -7);
            let end = shift_date(&monday, -1);
            UsageWindow {
                start: start.clone(),
                end: end.clone(),
                label: format!("last week ({} → {})", start, end),
            }
        }
        UsagePeriod::Week => rolling_window(&today, 7),
        UsagePeriod::ThisMonth => {
            let start = shift_month_start(&today, 0);
            UsageWindow {
                start: start.clone(),
                end: today.clone(),
                label: format!("this month ({} → {})", start, today),
            }
        }
        UsagePeriod::LastMonth => {
            let start = shift_month_start(&today, -1);
            let end = shift_month_end(&today, -1);
            UsageWindow {
                start: start.clone(),
                end: end.clone(),
                label: format!("last month ({} → {})", start, end),
            }
        }
        UsagePeriod::Month => rolling_window(&today, 30),
        UsagePeriod::Last => {
            let n = options.n.expect("n required for last period") as i64;
            rolling_window(&today, n)
        }
        UsagePeriod::Year => {
            let year = year_of(&today);
            UsageWindow {
                start: format!("{}-01-01", year),
                end: format!("{}-12-31", year),
                label: year.to_string(),
            }
        }
        UsagePeriod::All => UsageWindow {
            start: "0000-01-01".to_string(),
            end: "9999-12-31".to_string(),
            label: "all time".to_string(),
        },
    }
}

fn previous_equal_span(_today: &str, current: &UsageWindow) -> UsageWindow {
    let days = inclusive_day_count(&current.start, &current.end);
    let end = shift_date(&current.start, -1);
    let start = shift_date(&end, -(days - 1));
    UsageWindow {
        start: start.clone(),
        end: end.clone(),
        label: format!("previous period ({} → {})", start, end),
    }
}

pub fn compute_previous_usage_window(
    options: &UsageWindowOptions,
    current: Option<&UsageWindow>,
) -> UsageWindow {
    let today = today_string();
    let current_window = current
        .cloned()
        .unwrap_or_else(|| compute_usage_window(options));

    match options.period {
        UsagePeriod::Year => {
            let previous_year = year_of(&today) - 1;
            let start = format!("{}-01-01", previous_year);
            let end = same_day_in_year(&today, previous_year);
            UsageWindow {
                start: start.clone(),
                end: end.clone(),
                label: format!("previous year to date ({} → {})", start, end),
            }
        }
        UsagePeriod::All => {
            panic!("All-time usage does not have a comparable previous period")
        }
        _ => previous_equal_span(&today, &current_window),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_usage_window_today() {
        let options = UsageWindowOptions {
            period: UsagePeriod::Today,
            from: None,
            to: None,
            n: None,
        };
        let window = compute_usage_window(&options);
        assert_eq!(window.start, window.end);
    }

    #[test]
    fn test_compute_usage_window_week() {
        let options = UsageWindowOptions {
            period: UsagePeriod::Week,
            from: None,
            to: None,
            n: None,
        };
        let window = compute_usage_window(&options);
        let days = inclusive_day_count(&window.start, &window.end);
        assert_eq!(days, 7);
    }
}
