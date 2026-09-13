//! Calendar arithmetic on YYYY-MM-DD strings.
//!
//! Every helper here takes and returns local calendar date strings; none reads a
//! clock. They go through UTC purely because it has no DST discontinuities — the
//! strings are local dates and are never re-interpreted against a wall clock.

use chrono::{Datelike, NaiveDate, TimeDelta};

fn parse_date_string(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn format_date_string(value: &NaiveDate) -> String {
    value.format("%Y-%m-%d").to_string()
}

pub fn year_of(date: &str) -> u32 {
    date[0..4].parse().unwrap_or(0)
}

/// 1-based, to match how the string reads.
fn month_of(date: &str) -> u32 {
    date[5..7].parse().unwrap_or(1)
}

fn day_of(date: &str) -> u32 {
    date[8..10].parse().unwrap_or(1)
}

pub fn shift_date(value: &str, days: i64) -> String {
    if let Some(date) = parse_date_string(value) {
        if let Some(delta) = TimeDelta::try_days(days) {
            if let Some(shifted) = date.checked_add_signed(delta) {
                return format_date_string(&shifted);
            }
        }
    }
    value.to_string()
}

/// First day of the month `offset` months from the one `date` falls in.
pub fn shift_month_start(date: &str, offset: i32) -> String {
    let year = year_of(date) as i32;
    let month = month_of(date) as i32;
    let target_month = month + offset;

    let (final_year, final_month) = if target_month <= 0 {
        let years_back = (1 - target_month) / 12 + 1;
        (year - years_back, 12 + (target_month % 12))
    } else if target_month > 12 {
        (
            year + (target_month - 1) / 12,
            ((target_month - 1) % 12) + 1,
        )
    } else {
        (year, target_month)
    };

    format!("{:04}-{:02}-01", final_year, final_month)
}

/// Last day of the month `offset` months from the one `date` falls in.
pub fn shift_month_end(date: &str, offset: i32) -> String {
    let start = shift_month_start(date, offset + 1);
    if let Some(first_of_next) = parse_date_string(&start) {
        if let Some(last_day) = first_of_next.pred_opt() {
            return format_date_string(&last_day);
        }
    }
    date.to_string()
}

/// The same day of the month, `offset` months away, clamped to that month's
/// length — the 31st compared against a 30-day month lands on the 30th.
pub fn shift_month_same_day(date: &str, offset: i32) -> String {
    let start = shift_month_start(date, offset);
    let last_day = day_of(&shift_month_end(date, offset));
    let current_day = day_of(date);
    let clamped_day = current_day.min(last_day);
    format!("{}{:02}", &start[..8], clamped_day)
}

/// The same month and day in another year, clamped so Feb 29 survives.
pub fn same_day_in_year(date: &str, year: u32) -> String {
    let target = format!("{:04}{}", year, &date[4..]);
    let last_day = day_of(&shift_month_end(&target, 0));
    let current_day = day_of(date);
    let clamped_day = current_day.min(last_day);
    format!("{}{:02}", &target[..8], clamped_day)
}

/// Monday of the week `date` falls in.
pub fn monday_of_week(date: &str) -> String {
    if let Some(d) = parse_date_string(date) {
        let weekday = d.weekday().num_days_from_sunday();
        let offset = -((weekday as i64 + 6) % 7);
        return shift_date(date, offset);
    }
    date.to_string()
}

/// Number of days from `start` to `end`, inclusive of both ends.
pub fn inclusive_day_count(start: &str, end: &str) -> i64 {
    if let (Some(s), Some(e)) = (parse_date_string(start), parse_date_string(end)) {
        if let Some(delta) = e.signed_duration_since(s).num_days().checked_add(1) {
            return delta;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_year_of() {
        assert_eq!(year_of("2026-04-12"), 2026);
    }

    #[test]
    fn test_shift_date() {
        assert_eq!(shift_date("2026-01-15", 1), "2026-01-16");
        assert_eq!(shift_date("2026-01-31", 1), "2026-02-01");
        assert_eq!(shift_date("2026-03-01", -1), "2026-02-28");
    }

    #[test]
    fn test_shift_month_start() {
        assert_eq!(shift_month_start("2026-03-15", 0), "2026-03-01");
        assert_eq!(shift_month_start("2026-03-15", 1), "2026-04-01");
        assert_eq!(shift_month_start("2026-03-15", -1), "2026-02-01");
    }

    #[test]
    fn test_shift_month_end() {
        assert_eq!(shift_month_end("2026-03-15", 0), "2026-03-31");
        assert_eq!(shift_month_end("2026-03-15", 1), "2026-04-30");
        assert_eq!(shift_month_end("2026-02-15", 0), "2026-02-28");
    }

    #[test]
    fn test_monday_of_week() {
        assert_eq!(monday_of_week("2026-09-13"), "2026-09-07"); // Sunday -> prev Monday
    }

    #[test]
    fn test_inclusive_day_count() {
        assert_eq!(inclusive_day_count("2026-01-01", "2026-01-01"), 1);
        assert_eq!(inclusive_day_count("2026-01-01", "2026-01-31"), 31);
    }
}
