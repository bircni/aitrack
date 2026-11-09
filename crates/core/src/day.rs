use std::fmt;

use jiff::ToSpan;
use jiff::civil::{Date, Weekday};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A local calendar day, written `YYYY-MM-DD` as every day key in the data files is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Day(Date);

impl Day {
    /// The first and last days a data file can name; arithmetic stops at them.
    pub const MIN: Self = Self(Date::constant(0, 1, 1));
    pub const MAX: Self = Self(Date::constant(9999, 12, 31));

    #[must_use]
    pub fn new(year: i16, month: i8, day: i8) -> Option<Self> {
        Date::new(year, month, day).ok().filter(|_| (0..=9999).contains(&year)).map(Self)
    }

    /// A `YYYY-MM-DD` key naming a real date; `2026-02-30` is rejected rather than rolled over.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        let shaped = bytes.len() == 10
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
        if !shaped {
            return None;
        }
        Self::new(text[..4].parse().ok()?, text[5..7].parse().ok()?, text[8..].parse().ok()?)
    }

    #[must_use]
    pub const fn date(self) -> Date {
        self.0
    }

    #[must_use]
    pub fn year(self) -> i16 {
        self.0.year()
    }

    /// January 1st of `year`, kept within 0000-9999.
    #[must_use]
    pub fn year_start(year: i16) -> Self {
        Self(Self::MIN.0.saturating_add(i64::from(year.clamp(0, 9999)).years()))
    }

    /// December 31st of `year`, kept within 0000-9999.
    #[must_use]
    pub fn year_end(year: i16) -> Self {
        Self(Self::year_start(year).0.last_of_year())
    }

    #[must_use]
    pub fn shift(self, days: i64) -> Self {
        // Wider than 0000-9999 and within what a span holds, so clamping changes no in-range result.
        let days = days.clamp(-4_000_000, 4_000_000);
        Self(self.0.saturating_add(days.days()).clamp(Self::MIN.0, Self::MAX.0))
    }

    /// First day of the month `offset` months from this one.
    #[must_use]
    pub fn month_start(self, offset: i32) -> Self {
        let months = i64::from(self.0.year()) * 12 + i64::from(self.0.month()) - 1 + i64::from(offset);
        Self(Self::MIN.0.saturating_add(months.clamp(0, 9999 * 12 + 11).months()))
    }

    /// Last day of the month `offset` months from this one.
    #[must_use]
    pub fn month_end(self, offset: i32) -> Self {
        Self(self.month_start(offset).0.last_of_month())
    }

    /// The same day of the month `offset` months away, clamped to that month's length.
    #[must_use]
    pub fn same_day_months_away(self, offset: i32) -> Self {
        self.month_start(offset).with_day_of(self)
    }

    /// The same month and day in `year`, so Feb 29 becomes Feb 28 in a common year.
    #[must_use]
    pub fn same_day_in_year(self, year: i16) -> Self {
        let first = Self::year_start(year).0.saturating_add(i64::from(self.0.month() - 1).months());
        Self(first).with_day_of(self)
    }

    /// `other`'s day of the month in this day's month, clamped to its length.
    fn with_day_of(self, other: Self) -> Self {
        let first = self.0.first_of_month();
        Self(first.saturating_add(i64::from(other.0.day().min(first.days_in_month()) - 1).days()))
    }

    #[must_use]
    pub fn monday_of_week(self) -> Self {
        self.shift(-i64::from(self.0.weekday().to_monday_zero_offset()))
    }

    #[must_use]
    pub fn weekday(self) -> Weekday {
        self.0.weekday()
    }

    /// Days from `self` to `end`, counting both ends.
    #[must_use]
    pub fn inclusive_days_to(self, end: Self) -> i64 {
        i64::from((end.0 - self.0).get_days()) + 1
    }
}

impl From<Date> for Day {
    fn from(date: Date) -> Self {
        Self(date)
    }
}

impl fmt::Display for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.0.year(), self.0.month(), self.0.day())
    }
}

impl Serialize for Day {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Day {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <std::borrow::Cow<'de, str>>::deserialize(deserializer)?;
        Self::parse(&text).ok_or_else(|| serde::de::Error::custom(format!("not a calendar day: {text}")))
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::Day;

    fn day(text: &str) -> Day {
        Day::parse(text).unwrap()
    }

    fn shifted(text: &str, f: impl Fn(Day) -> Day) -> String {
        f(day(text)).to_string()
    }

    #[test]
    fn parses_only_real_day_keys() {
        assert_eq!(Day::parse("0001-01-01").map(Day::year), Some(1));
        for bad in ["2026-02-30", "2026-13-01", "2026-1-01", "2026-01-01T00:00:00Z", "+02026-01-01", "", "abcd-ef-gh"] {
            assert_eq!(Day::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn shifts_across_month_and_year_boundaries() {
        assert_eq!(shifted("2026-06-17", |d| d.shift(1)), "2026-06-18");
        assert_eq!(shifted("2026-06-30", |d| d.shift(1)), "2026-07-01");
        assert_eq!(shifted("2026-01-01", |d| d.shift(-1)), "2025-12-31");
        assert_eq!(shifted("2026-03-15", |d| d.shift(-30)), "2026-02-13");
    }

    #[test]
    fn stops_at_the_years_a_data_file_can_name() {
        assert_eq!(Day::MAX.shift(1), Day::MAX, "past 9999-12-31");
        assert_eq!(Day::MIN.shift(-i64::MAX), Day::MIN, "before 0000-01-01");
        assert_eq!(Day::MIN.month_start(-1), Day::MIN, "before the first month");
        assert_eq!(Day::year_start(-1), Day::MIN, "year below 0");
        assert_eq!(Day::year_end(20_000), Day::MAX, "year above 9999");
        assert_eq!(day("2024-02-29").same_day_in_year(2025).to_string(), "2025-02-28", "leap day");
    }

    #[test]
    fn finds_the_first_and_last_day_of_an_offset_month() {
        assert_eq!(shifted("2026-06-17", |d| d.month_start(0)), "2026-06-01");
        assert_eq!(shifted("2026-01-10", |d| d.month_start(-1)), "2025-12-01");
        assert_eq!(shifted("2026-02-10", |d| d.month_end(0)), "2026-02-28");
        assert_eq!(shifted("2024-02-10", |d| d.month_end(0)), "2024-02-29");
        assert_eq!(shifted("2026-06-17", |d| d.month_end(-1)), "2026-05-31");
    }

    #[test]
    fn clamps_month_shifts_and_year_projections() {
        assert_eq!(shifted("2026-03-31", |d| d.same_day_months_away(-1)), "2026-02-28");
        assert_eq!(shifted("2024-03-31", |d| d.same_day_months_away(-1)), "2024-02-29");
        assert_eq!(shifted("2026-05-31", |d| d.same_day_months_away(-1)), "2026-04-30");
        assert_eq!(shifted("2026-06-15", |d| d.same_day_months_away(-1)), "2026-05-15");
        assert_eq!(shifted("2024-02-29", |d| d.same_day_in_year(2023)), "2023-02-28");
        assert_eq!(shifted("2024-02-29", |d| d.same_day_in_year(2028)), "2028-02-29");
        assert_eq!(shifted("2026-07-04", |d| d.same_day_in_year(999)), "0999-07-04");
    }

    #[test]
    fn snaps_to_monday_and_counts_inclusively() {
        assert_eq!(shifted("2026-06-17", Day::monday_of_week), "2026-06-15");
        assert_eq!(shifted("2026-06-15", Day::monday_of_week), "2026-06-15");
        assert_eq!(shifted("2026-06-21", Day::monday_of_week), "2026-06-15");
        assert_eq!(day("2026-06-17").inclusive_days_to(day("2026-06-17")), 1);
        assert_eq!(day("2026-06-01").inclusive_days_to(day("2026-06-30")), 30);
        assert_eq!(day("2025-12-31").inclusive_days_to(day("2026-01-01")), 2);
    }

    fn any_day() -> impl Strategy<Value = Day> {
        (0i64..=47_846).prop_map(|offset| day("1970-01-01").shift(offset)) // through 2100-12-31
    }

    proptest! {
        #[test]
        fn shifting_is_reversible_and_counts_the_days_it_moved(d in any_day(), days in -4000i64..=4000) {
            let moved = d.shift(days);
            prop_assert_eq!(moved.shift(-days), d);
            let (from, to) = if days < 0 { (moved, d) } else { (d, moved) };
            prop_assert_eq!(from.inclusive_days_to(to), days.abs() + 1);
        }

        #[test]
        fn every_day_sits_in_a_monday_start_week(d in any_day()) {
            let monday = d.monday_of_week();
            prop_assert_eq!(monday.weekday(), jiff::civil::Weekday::Monday);
            prop_assert!((1..=7).contains(&monday.inclusive_days_to(d)));
        }

        #[test]
        fn month_shifts_stay_inside_the_target_month(d in any_day(), months in -240i32..=240) {
            let same = d.same_day_months_away(months);
            prop_assert!(d.month_start(months) <= same && same <= d.month_end(months));
        }

        #[test]
        fn display_and_parse_round_trip(d in any_day()) {
            prop_assert_eq!(Day::parse(&d.to_string()), Some(d));
        }
    }
}
