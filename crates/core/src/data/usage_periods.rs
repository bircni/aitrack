use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::day::Day;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsagePeriod {
    Today,
    Yesterday,
    Date,
    Range,
    ThisWeek,
    LastWeek,
    Week,
    ThisMonth,
    LastMonth,
    Month,
    Last,
    Year,
    All,
}

pub struct PeriodDefinition {
    /// As the CLI registers it, with its arguments.
    pub name: &'static str,
    pub period: UsagePeriod,
    pub key: &'static str,
    pub description: &'static str,
}

/// In the order the CLI lists them.
pub const USAGE_PERIODS: [PeriodDefinition; 13] = [
    PeriodDefinition {
        name: "today",
        period: UsagePeriod::Today,
        key: "today",
        description: "Today's usage: provider / tokens / model / price",
    },
    PeriodDefinition {
        name: "yesterday",
        period: UsagePeriod::Yesterday,
        key: "yesterday",
        description: "Yesterday's usage",
    },
    PeriodDefinition {
        name: "date <date>",
        period: UsagePeriod::Date,
        key: "date",
        description: "Usage for a specific date (YYYY-MM-DD)",
    },
    PeriodDefinition {
        name: "range <from> <to>",
        period: UsagePeriod::Range,
        key: "range",
        description: "Usage for a custom date range (YYYY-MM-DD YYYY-MM-DD)",
    },
    PeriodDefinition {
        name: "thisweek",
        period: UsagePeriod::ThisWeek,
        key: "thisweek",
        description: "Usage for the current calendar week (Mon–Sun)",
    },
    PeriodDefinition {
        name: "lastweek",
        period: UsagePeriod::LastWeek,
        key: "lastweek",
        description: "Usage for the previous calendar week (Mon–Sun)",
    },
    PeriodDefinition {
        name: "week",
        period: UsagePeriod::Week,
        key: "week",
        description: "Rolling 7-day usage ending today",
    },
    PeriodDefinition {
        name: "thismonth",
        period: UsagePeriod::ThisMonth,
        key: "thismonth",
        description: "Usage for the current calendar month",
    },
    PeriodDefinition {
        name: "lastmonth",
        period: UsagePeriod::LastMonth,
        key: "lastmonth",
        description: "Usage for the previous calendar month",
    },
    PeriodDefinition {
        name: "month",
        period: UsagePeriod::Month,
        key: "month",
        description: "Rolling 30-day usage ending today",
    },
    PeriodDefinition {
        name: "last <n>",
        period: UsagePeriod::Last,
        key: "last",
        description: "Rolling N-day usage ending today, e.g. last 14",
    },
    PeriodDefinition {
        name: "year",
        period: UsagePeriod::Year,
        key: "year",
        description: "Usage for the current calendar year",
    },
    PeriodDefinition {
        name: "all",
        period: UsagePeriod::All,
        key: "all",
        description: "All-time usage across every recorded day",
    },
];

/// Bounds every day key falls within.
#[must_use]
pub fn all_time() -> (Day, Day) {
    (Day::new(0, 1, 1).expect("valid"), Day::new(9999, 12, 31).expect("valid"))
}

/// A century: beyond it the window leaves the calendar range, and `usage all` is what is meant.
pub const MAX_LAST_DAYS: u64 = 36_500;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PeriodArgs {
    pub from: Option<Day>,
    pub to: Option<Day>,
    pub n: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageWindow {
    pub start: Day,
    pub end: Day,
    pub label: String,
}

impl UsagePeriod {
    #[must_use]
    pub fn parse(key: &str) -> Option<Self> {
        USAGE_PERIODS.iter().find(|d| d.key == key).map(|d| d.period)
    }

    #[must_use]
    pub fn key(self) -> &'static str {
        USAGE_PERIODS.iter().find(|d| d.period == self).expect("every period is registered").key
    }

    /// Windows that move with "today"; `date`, `range` and `all` do not.
    #[must_use]
    pub const fn anchors_on_today(self) -> bool {
        !matches!(self, Self::Date | Self::Range | Self::All)
    }

    /// The extra CLI arguments of `date`, `range` and `last`; the others accept none.
    pub fn parse_args(self, args: &[String]) -> Result<PeriodArgs, String> {
        let day = |value: &str| Day::parse(value).ok_or_else(|| invalid_date_message(value));
        match self {
            Self::Date => match args {
                [from] => Ok(PeriodArgs { from: Some(day(from)?), ..PeriodArgs::default() }),
                _ => Err("Period \"date\" expects a single date (YYYY-MM-DD).".to_owned()),
            },
            Self::Range => match args {
                [from, to] => {
                    let (start, end) = (day(from)?, day(to)?);
                    if start > end {
                        return Err(format!("Start date \"{from}\" must not be after end date \"{to}\"."));
                    }
                    Ok(PeriodArgs { from: Some(start), to: Some(end), n: None })
                }
                _ => Err("Period \"range\" expects two dates (YYYY-MM-DD YYYY-MM-DD).".to_owned()),
            },
            Self::Last => match args {
                [n] => {
                    let parsed = parse_positive_integer(n)
                        .ok_or_else(|| format!("Invalid number of days: \"{n}\". Expected a positive integer."))?;
                    if parsed > MAX_LAST_DAYS {
                        return Err(format!(
                            "Too many days: \"{n}\". The most is {MAX_LAST_DAYS}; use \"all\" for everything."
                        ));
                    }
                    Ok(PeriodArgs { n: Some(parsed), ..PeriodArgs::default() })
                }
                _ => Err("Period \"last\" expects a positive integer day count.".to_owned()),
            },
            _ if args.is_empty() => Ok(PeriodArgs::default()),
            _ => Err(format!("Period \"{}\" does not accept extra arguments.", self.key())),
        }
    }

    /// The window `today` puts this period in; `now_label` is what `today`'s label shows.
    pub fn window(self, today: Day, now_label: &str, args: PeriodArgs) -> Result<UsageWindow, String> {
        let span = |start: Day, end: Day, label: String| Ok(UsageWindow { start, end, label });
        match self {
            Self::Today => span(today, today, format!("today ({now_label})")),
            Self::Yesterday => {
                let date = today.shift(-1);
                span(date, date, format!("yesterday ({date})"))
            }
            Self::Date => {
                let from = args.from.ok_or("from is required for date period")?;
                span(from, from, from.to_string())
            }
            Self::Range => {
                let (Some(from), Some(to)) = (args.from, args.to) else {
                    return Err("from and to are required for range period".to_owned());
                };
                span(from, to, format!("{from} → {to}"))
            }
            Self::ThisWeek => {
                let start = today.monday_of_week();
                span(start, today, format!("this week ({start} → {today})"))
            }
            Self::LastWeek => {
                let monday = today.monday_of_week();
                let (start, end) = (monday.shift(-7), monday.shift(-1));
                span(start, end, format!("last week ({start} → {end})"))
            }
            Self::Week => Ok(rolling_window(today, 7)),
            Self::ThisMonth => {
                let start = today.month_start(0);
                span(start, today, format!("this month ({start} → {today})"))
            }
            Self::LastMonth => {
                let (start, end) = (today.month_start(-1), today.month_end(-1));
                span(start, end, format!("last month ({start} → {end})"))
            }
            Self::Month => Ok(rolling_window(today, 30)),
            Self::Last => Ok(rolling_window(today, args.n.filter(|n| *n > 0).ok_or("n is required for last period")?)),
            Self::Year => {
                let year = today.year();
                span(Day::new(year, 1, 1).expect("valid"), Day::new(year, 12, 31).expect("valid"), year.to_string())
            }
            Self::All => {
                let (start, end) = all_time();
                span(start, end, "all time".to_owned())
            }
        }
    }

    /// The comparable window just before `current`.
    pub fn previous(self, today: Day, current: &UsageWindow) -> Result<UsageWindow, String> {
        let span = |start: Day, end: Day, label: String| Ok(UsageWindow { start, end, label });
        match self {
            Self::ThisWeek | Self::LastWeek => {
                let prefix = if self == Self::ThisWeek { "previous week to date" } else { "week before" };
                let (start, end) = (current.start.shift(-7), current.end.shift(-7));
                span(start, end, format!("{prefix} ({start} → {end})"))
            }
            Self::ThisMonth => {
                let (start, end) = (current.end.month_start(-1), current.end.same_day_months_away(-1));
                span(start, end, format!("previous month to date ({start} → {end})"))
            }
            Self::LastMonth => {
                let (start, end) = (current.start.month_start(-1), current.start.month_end(-1));
                span(start, end, format!("month before ({start} → {end})"))
            }
            // The current window is the whole year, so the comparable slice comes from today.
            Self::Year => {
                let year = today.year() - 1;
                let (start, end) = (Day::new(year, 1, 1).expect("valid"), today.same_day_in_year(year));
                span(start, end, format!("previous year to date ({start} → {end})"))
            }
            Self::All => Err("All-time usage does not have a comparable previous period.".to_owned()),
            _ => {
                let days = current.start.inclusive_days_to(current.end);
                let end = current.start.shift(-1);
                let start = end.shift(-(days - 1));
                span(start, end, format!("previous period ({start} → {end})"))
            }
        }
    }
}

#[must_use]
pub fn invalid_date_message(value: &str) -> String {
    format!("Invalid date: \"{value}\". Expected YYYY-MM-DD.")
}

/// Digits only, so `1e3`, `0x10` and `1.0` are rejected rather than coerced.
#[must_use]
pub fn parse_positive_integer(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|n| (1..=(1u64 << 53) - 1).contains(n))
}

/// The `n` days ending `today`, inclusive.
#[must_use]
pub fn rolling_window(today: Day, n: u64) -> UsageWindow {
    let start = today.shift(-i64::try_from(n).unwrap_or(i64::MAX / 2) + 1);
    UsageWindow { start, end: today, label: format!("last {n} days ({start} → {today})") }
}

/// `toLocaleDateString()` and `toLocaleTimeString()` for en-US: `4/5/2026 2:05:09 AM`.
#[must_use]
pub fn locale_now_label(now: Timestamp, zone: &TimeZone) -> String {
    let local = now.to_zoned(zone.clone());
    let hour = local.hour();
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    let meridiem = if hour < 12 { "AM" } else { "PM" };
    format!(
        "{}/{}/{} {twelve}:{:02}:{:02} {meridiem}",
        local.month(),
        local.day(),
        local.year(),
        local.minute(),
        local.second()
    )
}
