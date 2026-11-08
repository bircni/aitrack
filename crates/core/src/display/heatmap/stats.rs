use std::cmp::Ordering;

use indexmap::IndexMap;
use serde::Serialize;

use super::constants::{HEATMAP_WEEKS, RECENT_WINDOW_DAYS};
use crate::data::types::{DayEntry, DayMap};
use crate::data::usage_periods::rolling_window;
use crate::day::Day;

pub const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// One grid column: Sunday to Saturday, `None` outside the range.
pub type Week = [Option<Day>; 7];

const fn tokens(entry: &DayEntry) -> u64 {
    entry.counts.input_tokens + entry.counts.output_tokens
}

fn has_activity(days: &DayMap, day: Day) -> bool {
    days.get(&day).is_some_and(|e| tokens(e) > 0)
}

/// An idle today does not break the streak, since today is still in progress.
#[must_use]
pub fn current_streak(days: &DayMap, today: Day) -> u64 {
    let mut day = if has_activity(days, today) { today } else { today.shift(-1) };
    let mut streak = 0;
    while has_activity(days, day) {
        streak += 1;
        day = day.shift(-1);
    }
    streak
}

#[must_use]
pub fn longest_streak(days: &DayMap) -> u64 {
    let mut active: Vec<Day> = days.iter().filter(|(_, e)| tokens(e) > 0).map(|(d, _)| *d).collect();
    active.sort_unstable();
    let (mut longest, mut current) = (0, 0);
    let mut previous: Option<Day> = None;
    for date in active {
        current = if previous.is_some_and(|p| p.shift(1) == date) { current + 1 } else { 1 };
        longest = longest.max(current);
        previous = Some(date);
    }
    longest
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PeakMonth {
    /// `YYYY-MM`.
    pub month: String,
    pub tokens: u64,
}

#[must_use]
pub fn peak_month(days: &DayMap) -> Option<PeakMonth> {
    let mut months: IndexMap<String, u64> = IndexMap::new();
    for (date, entry) in days {
        let total = tokens(entry);
        if total > 0 {
            *months.entry(date.to_string()[..7].to_owned()).or_default() += total;
        }
    }
    let mut best: Option<PeakMonth> = None;
    for (month, tokens) in months {
        if best.as_ref().is_none_or(|b| tokens > b.tokens) {
            best = Some(PeakMonth { month, tokens });
        }
    }
    best
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelTop {
    pub model: String,
    pub tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PeakDay {
    pub date: Day,
    pub tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStats {
    pub top_all_time: Option<ModelTop>,
    pub top_recent: Option<ModelTop>,
    pub peak: Option<PeakDay>,
}

/// A tie goes to the model sorting first, compared as JS strings are.
fn bump(table: &mut IndexMap<String, u64>, model: &str, delta: u64, track: Option<ModelTop>) -> ModelTop {
    let next = table.get(model).copied().unwrap_or(0) + delta;
    table.insert(model.to_owned(), next);
    match track {
        Some(t) if next < t.tokens => t,
        Some(t) if next == t.tokens && model.encode_utf16().cmp(t.model.encode_utf16()) != Ordering::Less => t,
        _ => ModelTop { model: model.to_owned(), tokens: next },
    }
}

#[must_use]
pub fn compute_model_stats(days: &DayMap, today: Day) -> ModelStats {
    let since = rolling_window(today, RECENT_WINDOW_DAYS).start;
    let (mut all_time, mut recent) = (IndexMap::new(), IndexMap::new());
    let (mut top_all, mut top_recent, mut peak): (Option<ModelTop>, Option<ModelTop>, Option<PeakDay>) =
        (None, None, None);
    for (date, entry) in days {
        let day_total = tokens(entry);
        if day_total > 0 && peak.as_ref().is_none_or(|p| day_total > p.tokens) {
            peak = Some(PeakDay { date: *date, tokens: day_total });
        }
        for (model, counts) in &entry.by_model {
            let model_tokens = counts.input_tokens + counts.output_tokens;
            if model_tokens == 0 {
                continue;
            }
            top_all = Some(bump(&mut all_time, model, model_tokens, top_all));
            if *date >= since {
                top_recent = Some(bump(&mut recent, model, model_tokens, top_recent));
            }
        }
    }
    ModelStats { top_all_time: top_all, top_recent, peak }
}

fn month_name(month: i8) -> String {
    usize::try_from(month - 1)
        .ok()
        .and_then(|i| MONTHS.get(i))
        .map_or_else(|| format!("{month:02}"), |m| (*m).to_owned())
}

/// `Mar 1, 2026`.
#[must_use]
pub fn format_peak_date(date: Day) -> String {
    let text = date.to_string();
    format!("{} {}, {}", month_name(date.date().month()), date.date().day(), &text[..4])
}

/// `YYYY-MM` as `Mar 2026`.
#[must_use]
pub fn format_month_label(month: &str) -> String {
    let (year, number) = month.split_once('-').unwrap_or((month, ""));
    let name = number.parse::<i8>().ok().and_then(|m| usize::try_from(m - 1).ok()).and_then(|i| MONTHS.get(i));
    format!("{} {year}", name.copied().unwrap_or(number))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MonthLabel {
    pub column: usize,
    pub label: &'static str,
}

/// Grid columns that get a month label; a label is wider than one column.
#[must_use]
pub fn month_labels(weeks: &[Week]) -> Vec<MonthLabel> {
    let mut labels = Vec::new();
    let mut last_month = -1;
    for (column, week) in weeks.iter().enumerate() {
        let Some(first) = week.iter().flatten().next() else { continue };
        let month = first.date().month() - 1;
        if month != last_month {
            labels.push(MonthLabel { column, label: MONTHS[usize::try_from(month).unwrap_or(0)] });
            last_month = month;
        }
    }
    // A rolling grid can open on a month's last days, right against the next label.
    if labels.get(1).is_some_and(|l| l.column == 1) {
        labels.remove(0);
    }
    labels
}

fn weekday_of(day: Day) -> i64 {
    i64::from(day.weekday().to_sunday_zero_offset())
}

/// The trailing 52 weeks, or one calendar year, as Sunday-first columns.
#[must_use]
pub fn build_date_grid(year: Option<i16>, today: Day) -> Vec<Week> {
    let (first, last) = match year {
        None => (today.shift(-weekday_of(today) - HEATMAP_WEEKS * 7), today),
        Some(year) => {
            let first = Day::new(year, 1, 1).expect("a grid year within 0000-9999");
            (first, if year == today.year() { today } else { Day::new(year, 12, 31).expect("valid") })
        }
    };
    let lead = weekday_of(first);
    let end = lead + first.inclusive_days_to(last);
    let weeks = (end + 6) / 7;
    (0..weeks)
        .map(|week| {
            std::array::from_fn(|weekday| {
                let index = week * 7 + i64::try_from(weekday).unwrap_or(0);
                (index >= lead && index < end).then(|| first.shift(index - lead))
            })
        })
        .collect()
}
