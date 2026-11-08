//! How a window reads at a glance: whether it has reset, its colour, and when something happens.

use aitrack_core::quota::pacing::{js_round, PaceProjection, PaceSeverity};
use aitrack_core::quota::QuotaWindow;
use aitrack_core::time::Clock;
use jiff::tz::TimeZone;
use jiff::Timestamp;
use serde::Serialize;

/// `Date.parse`: epoch ms, or NaN for what V8 cannot read.
pub fn parse_ms(clock: &Clock, text: &str) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    clock.parse_timestamp(text).map_or(f64::NAN, |at| at.as_millisecond() as f64)
}

/// A cached window whose reset has passed says nothing about the limit now.
pub fn has_reset(clock: &Clock, window: &QuotaWindow, now: f64) -> bool {
    window.resets_at.as_deref().is_some_and(|at| parse_ms(clock, at) <= now)
}

/// Least to most urgent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    Neutral,
    Calm,
    Warn,
    Crit,
}

/// A window's colour: its pace when there is one, otherwise how full it is.
pub fn meter_tone(window: &QuotaWindow, pace: &PaceProjection) -> Tone {
    match pace.severity {
        PaceSeverity::Level => {
            let used = js_round(window.used_percent);
            if used >= 90.0 {
                Tone::Crit
            } else if used >= 80.0 {
                Tone::Warn
            } else {
                Tone::Calm
            }
        }
        PaceSeverity::Close => Tone::Warn,
        PaceSeverity::Healthy => Tone::Calm,
        PaceSeverity::RunningOut | PaceSeverity::Spent => Tone::Crit,
    }
}

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "7:20 PM" today, "Sun 9:00 PM" within a week, "Oct 16" beyond, as Node's en-US formats them.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn format_when(at: f64, now: f64, zone: &TimeZone) -> String {
    let local = |ms: f64| Timestamp::from_millisecond(ms as i64).unwrap_or_default().to_zoned(zone.clone());
    let (date, today) = (local(at), local(now));
    let days = (date.date() - today.date()).get_days();
    let hour = date.hour();
    let clock = format!(
        "{}:{:02}\u{202f}{}",
        if hour % 12 == 0 { 12 } else { hour % 12 },
        date.minute(),
        if hour < 12 { "AM" } else { "PM" }
    );
    if days <= 0 {
        return clock;
    }
    if days < 7 {
        return format!("{} {clock}", WEEKDAYS[date.weekday().to_monday_zero_offset() as usize]);
    }
    format!("{} {}", MONTHS[(date.month() - 1) as usize], date.day())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::cast_precision_loss)]
    fn says_when_in_the_local_calendar() {
        let zone = TimeZone::get("Europe/Berlin").unwrap();
        let ms = |text: &str| text.parse::<Timestamp>().unwrap().as_millisecond() as f64;
        let now = ms("2026-06-01T10:00:00Z");
        assert_eq!(format_when(ms("2026-06-01T17:20:00Z"), now, &zone), "7:20\u{202f}PM");
        assert_eq!(format_when(ms("2026-06-01T22:05:00Z"), now, &zone), "Tue 12:05\u{202f}AM");
        assert_eq!(format_when(ms("2026-06-07T19:00:00Z"), now, &zone), "Sun 9:00\u{202f}PM");
        assert_eq!(format_when(ms("2026-06-08T10:00:00Z"), now, &zone), "Jun 8");
    }
}
