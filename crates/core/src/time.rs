use jiff::civil::{Date, DateTime, Time};
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

use crate::day::Day;

/// Written on machine files whose zone is unrecoverable; deliberately not an IANA name.
pub const UNKNOWN_TIMEZONE: &str = "unknown";

/// The current instant and the zone local calendar days are counted in.
///
/// Passed in rather than read from the process, so tests pin both instead of mutating `TZ`.
#[derive(Clone, Debug)]
pub struct Clock {
    now: Option<Timestamp>,
    zone: TimeZone,
}

impl Clock {
    #[must_use]
    pub fn system() -> Self {
        Self { now: None, zone: TimeZone::system() }
    }

    /// The real time, with days counted in `zone`.
    pub fn in_zone(zone: &str) -> Result<Self, jiff::Error> {
        Ok(Self { now: None, zone: TimeZone::get(zone)? })
    }

    pub fn fixed(now: Timestamp, zone: &str) -> Result<Self, jiff::Error> {
        Ok(Self { now: Some(now), zone: TimeZone::get(zone)? })
    }

    #[must_use]
    pub fn now(&self) -> Timestamp {
        self.now.unwrap_or_else(Timestamp::now)
    }

    #[must_use]
    pub fn zone(&self) -> &TimeZone {
        &self.zone
    }

    /// The IANA name recorded on machine files and in cache keys, `UTC` when the system has none.
    #[must_use]
    pub fn zone_name(&self) -> &str {
        self.zone.iana_name().unwrap_or("UTC")
    }

    #[must_use]
    pub fn today(&self) -> Day {
        self.local_day(self.now())
    }

    #[must_use]
    pub fn local_day(&self, instant: Timestamp) -> Day {
        instant.to_zoned(self.zone.clone()).date().into()
    }

    /// The local day of a log timestamp, or `None` when `new Date(text)` would be invalid.
    #[must_use]
    pub fn parse_local_day(&self, text: &str) -> Option<Day> {
        self.parse_timestamp(text).map(|instant| self.local_day(instant))
    }

    /// `new Date(text)` for the ISO forms the logs use.
    ///
    /// A date alone is UTC midnight, a date and time without an offset is local time, and a day
    /// up to 31 rolls into the next month as V8 does (`2026-02-30` is March 2).
    #[must_use]
    pub fn parse_timestamp(&self, text: &str) -> Option<Timestamp> {
        let mut parser = Parser(text.as_bytes());
        let year = i16::try_from(parser.digits(4)?).ok()?;
        parser.expect(b'-')?;
        let month = i8::try_from(parser.digits(2)?).ok()?;
        parser.expect(b'-')?;
        let day = parser.digits(2)?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        let date = Date::new(year, month, 1).ok()?.checked_add(i64::from(day - 1).days()).ok()?;
        if parser.done() {
            return date.to_zoned(TimeZone::UTC).ok().map(|zoned| zoned.timestamp());
        }
        parser.expect_any(b"T ")?;
        let hour = parser.digits(2)?;
        parser.expect(b':')?;
        let minute = parser.digits(2)?;
        let (mut second, mut millis) = (0, 0);
        if parser.peek() == Some(b':') {
            parser.expect(b':')?;
            second = parser.digits(2)?;
            if parser.peek() == Some(b'.') {
                parser.expect(b'.')?;
                millis = parser.fraction_millis()?;
            }
        }
        if hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        let time = Time::new(
            i8::try_from(hour).ok()?,
            i8::try_from(minute).ok()?,
            i8::try_from(second).ok()?,
            millis * 1_000_000,
        )
        .ok()?;
        let local = DateTime::from_parts(date, time);
        let zone = match parser.peek() {
            None => self.zone.clone(),
            Some(b'Z') => {
                parser.expect(b'Z')?;
                TimeZone::UTC
            }
            Some(sign @ (b'+' | b'-')) => {
                parser.expect(sign)?;
                let hours = parser.digits(2)?;
                parser.expect(b':')?;
                let minutes = parser.digits(2)?;
                let seconds = (hours * 3600 + minutes * 60) * if sign == b'-' { -1 } else { 1 };
                TimeZone::fixed(jiff::tz::Offset::from_seconds(seconds).ok()?)
            }
            Some(_) => return None,
        };
        if !parser.done() {
            return None;
        }
        // `to_zoned` resolves a skipped local time forward and a repeated one to the earlier offset, as JS does.
        local.to_zoned(zone).ok().map(|zoned| zoned.timestamp())
    }
}

/// `Date.prototype.toISOString`: always milliseconds and `Z`.
#[must_use]
pub fn iso_millis(instant: Timestamp) -> String {
    instant.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// The calendar date in a recorded zone, or `None` when it was never recorded or is not a real IANA name.
#[must_use]
pub fn calendar_date_in_zone(zone: &str, now: Timestamp) -> Option<Day> {
    if zone.is_empty() || zone == UNKNOWN_TIMEZONE {
        return None;
    }
    let zone = TimeZone::get(zone).ok()?;
    Some(now.to_zoned(zone).date().into())
}

struct Parser<'a>(&'a [u8]);

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.0.first().copied()
    }

    fn done(&self) -> bool {
        self.0.is_empty()
    }

    fn expect(&mut self, byte: u8) -> Option<()> {
        self.expect_any(&[byte])
    }

    fn expect_any(&mut self, bytes: &[u8]) -> Option<()> {
        let (&first, rest) = self.0.split_first()?;
        bytes.contains(&first).then(|| self.0 = rest)
    }

    fn digits(&mut self, count: usize) -> Option<i32> {
        let (head, rest) = self.0.split_at_checked(count)?;
        if !head.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.0 = rest;
        head.iter().try_fold(0i32, |acc, digit| acc.checked_mul(10)?.checked_add(i32::from(digit - b'0')))
    }

    /// Any number of fraction digits, truncated to milliseconds.
    fn fraction_millis(&mut self) -> Option<i32> {
        let count = self.0.iter().take_while(|b| b.is_ascii_digit()).count();
        if count == 0 {
            return None;
        }
        let mut millis = 0;
        for i in 0..3 {
            millis = millis * 10 + self.0.get(i).filter(|_| i < count).map_or(0, |b| i32::from(b - b'0'));
        }
        self.0 = &self.0[count..];
        Some(millis)
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;

    use super::{Clock, calendar_date_in_zone, iso_millis};

    #[test]
    fn parses_timestamps_as_node_does_in_every_fixture_zone() {
        let rows: Vec<(String, String, Option<i64>, Option<String>)> =
            serde_json::from_str(include_str!("../tests/fixtures/js/timestamps.json")).unwrap();
        for (text, zone, millis, day) in rows {
            let clock = Clock::in_zone(&zone).unwrap();
            let parsed = clock.parse_timestamp(&text);
            assert_eq!(parsed.map(Timestamp::as_millisecond), millis, "{text:?} in {zone}");
            assert_eq!(clock.parse_local_day(&text).map(|d| d.to_string()), day, "{text:?} in {zone}");
        }
    }

    #[test]
    fn writes_iso_milliseconds_and_names_recorded_zones() {
        let instant: Timestamp = "2026-03-08T10:00:00.5Z".parse().unwrap();
        assert_eq!(iso_millis(instant), "2026-03-08T10:00:00.500Z");
        assert_eq!(calendar_date_in_zone("Pacific/Kiritimati", instant).unwrap().to_string(), "2026-03-09");
        for zone in ["", "unknown", "Mars/Olympus"] {
            assert_eq!(calendar_date_in_zone(zone, instant), None);
        }
        let clock = Clock::fixed(instant, "Pacific/Midway").unwrap();
        assert_eq!((clock.zone_name(), clock.today().to_string()), ("Pacific/Midway", "2026-03-07".to_owned()));
    }
}
