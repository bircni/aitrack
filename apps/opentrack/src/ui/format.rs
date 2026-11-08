//! What the popup says about the numbers, in en-US as the 4.x renderer wrote it for that locale.

use std::collections::BTreeMap;

use aitrack_core::day::Day;
use aitrack_core::display::format::{fmt, fmt_usd_cost, group_thousands};
pub use aitrack_core::display::heatmap::intensity::intensity_level;
use aitrack_core::display::heatmap::stats::MONTHS;
use aitrack_core::quota::pacing::{js_round, PaceProjection, PaceSeverity};
use aitrack_core::quota::{QuotaError, QuotaErrorKind, QuotaFormat, QuotaWindow};
use aitrack_core::time::Clock;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::Timestamp;

use crate::pace::{format_when, parse_ms};
use crate::state::{
    AppState, DailyUsage, MachineUsage, ModelUsage, PeriodUsage, ProjectProviderEntry, ProjectUsageEntry,
    ProjectUsages, ProviderState, ProviderUsage,
};

pub const INIT_HINT: &str = "npx aitrack init";
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Spend {
    pub tokens: f64,
    pub cost_usd: f64,
    pub has_cost: bool,
    pub has_unpriced_tokens: bool,
}

macro_rules! spend_from {
    ($($t:ty),*) => {$(
        impl From<&$t> for Spend {
            fn from(value: &$t) -> Self {
                Self {
                    tokens: value.tokens,
                    cost_usd: value.cost_usd,
                    has_cost: value.has_cost,
                    has_unpriced_tokens: value.has_unpriced_tokens,
                }
            }
        }
    )*};
}
spend_from!(PeriodUsage, ModelUsage, ProjectUsageEntry, ProjectProviderEntry);

pub fn format_cost(value: f64) -> String {
    fmt_usd_cost(value)
}

pub fn format_tokens(value: f64) -> String {
    fmt(value)
}

/// "May 11" for a `YYYY-MM-DD` calendar day.
pub fn format_day(date: &str) -> String {
    date.parse::<Date>().map_or_else(
        |_| String::new(),
        |day| format!("{} {}", MONTHS[usize::try_from(day.month() - 1).unwrap_or(0)], day.day()),
    )
}

/// `Intl.NumberFormat('en-US')`: grouped, up to three decimals.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the value is rounded and bounded to the target range first"
)]
pub fn format_number(value: f64) -> String {
    let scaled = js_round(value.abs() * 1000.0);
    let (int, frac) = ((scaled / 1000.0).trunc() as u64, (scaled % 1000.0) as u64);
    let sign = if value < 0.0 && scaled > 0.0 { "-" } else { "" };
    let frac = if frac == 0 { String::new() } else { format!(".{frac:03}").trim_end_matches('0').to_owned() };
    format!("{sign}{}{frac}", group_thousands(&int.to_string()))
}

/// `fraction` is 0–1.
pub fn format_percent(fraction: f64) -> String {
    format!("{}%", js_round(fraction * 100.0))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Period {
    Today,
    Week,
    Month,
    All,
}

impl Period {
    pub const ALL: [Self; 4] = [Self::Today, Self::Week, Self::Month, Self::All];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Today => "Today",
            Self::Week => "7 days",
            Self::Month => "30 days",
            Self::All => "All time",
        }
    }
}

pub fn period_spend(usage: Option<&ProviderUsage>, period: Period) -> Option<&PeriodUsage> {
    usage.map(|usage| match period {
        Period::Today => &usage.today,
        Period::Week => &usage.last7_days,
        Period::Month => &usage.last30_days,
        Period::All => &usage.all_time,
    })
}

/// The period's spend, nothing when the provider has no usage.
pub fn period_value(usage: Option<&ProviderUsage>, period: Period) -> Spend {
    period_spend(usage, period).map_or_else(Spend::default, Spend::from)
}

pub fn period_projects(projects: Option<&ProjectUsages>, period: Period) -> &[ProjectUsageEntry] {
    projects.map_or(&[], |projects| match period {
        Period::Today => &projects.today,
        Period::Week => &projects.last7_days,
        Period::Month => &projects.last30_days,
        Period::All => &projects.all_time,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    Ready,
    Loading,
    Failed,
    Empty,
    Off,
}

pub fn usage_availability(state: &AppState) -> Availability {
    if state.providers.is_empty() {
        return Availability::Off;
    }
    if state.usage_empty == Some(true) && state.usage_error.is_none() {
        return Availability::Empty;
    }
    if state.providers.iter().any(|p| p.usage.is_some()) {
        return Availability::Ready;
    }
    if state.refreshing || state.usage_error.is_none() {
        Availability::Loading
    } else {
        Availability::Failed
    }
}

pub const fn usage_note(availability: Availability) -> &'static str {
    match availability {
        Availability::Ready | Availability::Loading => "Reading usage…",
        Availability::Failed => "Usage could not be read",
        Availability::Empty => "No usage found yet",
        Availability::Off => "No providers are turned on",
    }
}

/// `Intl.ListFormat('en', { type: 'disjunction' })`.
fn or_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [a, b] => format!("{a} or {b}"),
        [rest @ .., last] => format!("{}, or {last}", rest.join(", ")),
    }
}

pub fn empty_usage_guidance(labels: &[&str]) -> String {
    format!("Use {}, then refresh. To add your other machines, run `{INIT_HINT}`.", or_list(labels))
}

/// Unpriced tokens are not free, so their cost is a dash rather than $0.00.
pub fn is_priced(spend: &Spend) -> bool {
    spend.has_cost || spend.tokens == 0.0
}

pub fn spend_label(spend: &Spend) -> String {
    if !is_priced(spend) {
        return "—".into();
    }
    let partial = if spend.has_cost && spend.has_unpriced_tokens { " (partial)" } else { "" };
    format!("{}{partial}", format_cost(spend.cost_usd))
}

pub fn spend_reading(spend: &Spend) -> String {
    let tokens = format!("{} tokens", format_tokens(spend.tokens));
    if spend.has_cost {
        format!("{} · {tokens}", spend_label(spend))
    } else {
        tokens
    }
}

pub fn total_spend<'a>(usages: impl IntoIterator<Item = Option<&'a ProviderUsage>>, period: Period) -> Spend {
    usages.into_iter().fold(Spend::default(), |total, usage| {
        let spend = period_value(usage, period);
        Spend {
            cost_usd: total.cost_usd + spend.cost_usd,
            tokens: total.tokens + spend.tokens,
            has_cost: total.has_cost || spend.has_cost,
            has_unpriced_tokens: total.has_unpriced_tokens || spend.has_unpriced_tokens,
        }
    })
}

pub struct ShareBasis {
    pub by_cost: bool,
    pub total: f64,
}

impl ShareBasis {
    /// Shares follow cost while anything is priced, so an unpriced row does not look free.
    pub fn new<'a>(spends: impl IntoIterator<Item = &'a Spend> + Clone) -> Self {
        let by_cost = spends.clone().into_iter().any(|s| s.cost_usd > 0.0);
        let mut basis = Self { by_cost, total: 0.0 };
        basis.total = spends.into_iter().map(|s| basis.measure(s)).sum();
        basis
    }

    pub const fn measure(&self, spend: &Spend) -> f64 {
        if self.by_cost {
            spend.cost_usd
        } else {
            spend.tokens
        }
    }
}

/// The latest `days` of the summed daily series.
pub fn combined_daily<'a>(usages: impl IntoIterator<Item = Option<&'a ProviderUsage>>, days: usize) -> Vec<DailyUsage> {
    let mut by_date: BTreeMap<String, DailyUsage> = BTreeMap::new();
    for usage in usages.into_iter().flatten() {
        for day in &usage.daily {
            let total = by_date.entry(day.date.clone()).or_insert_with(|| DailyUsage {
                date: day.date.clone(),
                cost_usd: 0.0,
                has_unpriced_tokens: false,
            });
            total.cost_usd += day.cost_usd;
            total.has_unpriced_tokens |= day.has_unpriced_tokens;
        }
    }
    let list: Vec<DailyUsage> = by_date.into_values().collect();
    list[list.len().saturating_sub(days)..].to_vec()
}

pub fn day_cost_label(day: &DailyUsage) -> String {
    if !day.has_unpriced_tokens {
        format_cost(day.cost_usd)
    } else if day.cost_usd > 0.0 {
        format!("{} (partial)", format_cost(day.cost_usd))
    } else {
        "Not priced".into()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bucket {
    Day,
    Week,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryPart {
    pub key: String,
    pub label: String,
    pub cost_usd: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryBar {
    pub start: String,
    pub total_usd: f64,
    pub parts: Vec<HistoryPart>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryProvider {
    pub key: String,
    pub label: String,
    pub cost_usd: f64,
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct History {
    pub bars: Vec<HistoryBar>,
    pub total_usd: f64,
    pub average_usd: f64,
    pub from: String,
    pub to: String,
    pub peak_usd: f64,
    pub busiest: String,
    pub by_provider: Vec<HistoryProvider>,
    pub has_unpriced_tokens: bool,
}

/// Monday of the week `date` falls in.
pub fn monday_of_week(date: &str) -> String {
    Day::parse(date).map_or_else(|| date.to_owned(), |day| day.monday_of_week().to_string())
}

/// Stacked cost per day (or week) over the last `range` days, split by provider.
pub fn build_history(providers: &[ProviderState], range: usize, bucket: Bucket) -> History {
    let mut dates: Vec<&str> = providers
        .iter()
        .filter_map(|p| p.usage.as_ref())
        .flat_map(|u| u.daily.iter().map(|d| d.date.as_str()))
        .collect();
    dates.sort_unstable();
    dates.dedup();
    let dates = &dates[dates.len().saturating_sub(range)..];
    let in_range = |date: &str| dates.binary_search(&date).is_ok();
    let mut bars: BTreeMap<String, HistoryBar> = BTreeMap::new();
    for provider in providers {
        for day in provider.usage.iter().flat_map(|u| &u.daily) {
            if !in_range(&day.date) {
                continue;
            }
            let start = if bucket == Bucket::Day { day.date.clone() } else { monday_of_week(&day.date) };
            let bar = bars.entry(start.clone()).or_insert(HistoryBar { start, total_usd: 0.0, parts: Vec::new() });
            bar.total_usd += day.cost_usd;
            match bar.parts.iter_mut().find(|part| part.key == provider.key) {
                Some(part) => part.cost_usd += day.cost_usd,
                None => bar.parts.push(HistoryPart {
                    key: provider.key.clone(),
                    label: provider.label.clone(),
                    cost_usd: day.cost_usd,
                }),
            }
        }
    }
    let bars: Vec<HistoryBar> = bars.into_values().collect();
    let total_usd = bars.iter().map(|b| b.total_usd).sum();
    let peak = bars.iter().fold(None::<&HistoryBar>, |best, bar| {
        if bar.total_usd > best.map_or(0.0, |b| b.total_usd) {
            Some(bar)
        } else {
            best
        }
    });
    let mut by_provider: Vec<HistoryProvider> = providers
        .iter()
        .map(|p| {
            let days: Vec<&DailyUsage> = p.usage.iter().flat_map(|u| &u.daily).filter(|d| in_range(&d.date)).collect();
            HistoryProvider {
                key: p.key.clone(),
                label: p.label.clone(),
                cost_usd: days.iter().map(|d| d.cost_usd).sum(),
                has_unpriced_tokens: days.iter().any(|d| d.has_unpriced_tokens),
            }
        })
        .filter(|p| p.cost_usd > 0.0 || p.has_unpriced_tokens)
        .collect();
    by_provider.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
    #[expect(
        clippy::cast_precision_loss,
        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
    )]
    let average_usd = if dates.is_empty() { 0.0 } else { total_usd / dates.len() as f64 };
    History {
        total_usd,
        average_usd,
        from: dates.first().map(|d| (*d).to_owned()).unwrap_or_default(),
        to: dates.last().map(|d| (*d).to_owned()).unwrap_or_default(),
        peak_usd: peak.map_or(0.0, |b| b.total_usd),
        busiest: peak.map(|b| b.start.clone()).unwrap_or_default(),
        has_unpriced_tokens: by_provider.iter().any(|p| p.has_unpriced_tokens),
        by_provider,
        bars,
    }
}

/// "$115" and ".70", so the cents can be set quieter.
pub fn split_amount(value: f64) -> (String, String) {
    let text = format_cost(value);
    match text.rsplit_once('.') {
        Some((whole, cents)) if !text.starts_with('<') => (whole.to_owned(), format!(".{cents}")),
        _ => (text, String::new()),
    }
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the value is rounded and bounded to the target range first"
)]
pub fn format_duration(ms: f64) -> String {
    let minutes = (ms / 60_000.0).ceil().max(1.0) as u64;
    let (days, hours, rest) = (minutes / 1440, (minutes % 1440) / 60, minutes % 60);
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        if rest > 0 {
            format!("{hours}h {rest}m")
        } else {
            format!("{hours}h")
        }
    } else {
        format!("{rest}m")
    }
}

pub fn format_reset(clock: &Clock, resets_at: Option<&str>, now: f64, relative: bool) -> Option<String> {
    let at = parse_ms(clock, resets_at?);
    if at.is_nan() {
        return None;
    }
    Some(if at <= now {
        "Reset passed, waiting for new data".into()
    } else if at - now <= 60_000.0 {
        "Resets soon".into()
    } else if relative {
        format!("Resets in {}", format_duration(at - now))
    } else {
        format!("Resets {}", format_when(at, now, clock.zone()))
    })
}

/// The note under a meter; nothing when there is too little to judge.
pub fn pace_label(pace: &PaceProjection, now: f64, zone: &TimeZone) -> Option<String> {
    match pace.severity {
        PaceSeverity::Level => None,
        PaceSeverity::Healthy => Some("On pace".into()),
        PaceSeverity::Close => Some("Tight".into()),
        PaceSeverity::RunningOut => Some(
            pace.run_out_at
                .map_or_else(|| "Will run out".into(), |at| format!("Runs out {}", format_when(at, now, zone))),
        ),
        PaceSeverity::Spent => Some("Limit reached".into()),
    }
}

pub fn fill_percent(window: &QuotaWindow, left: bool) -> f64 {
    let used = window.used_percent.clamp(0.0, 100.0);
    if left {
        100.0 - used
    } else {
        used
    }
}

/// "13%" or "87% left"; "$12.50 / $50.00" for money windows.
pub fn format_limit_value(window: &QuotaWindow, left: bool) -> String {
    let suffix = if left { " left" } else { "" };
    if let (QuotaFormat::Dollars, Some(used), Some(limit)) = (window.format, window.used_value, window.limit_value) {
        let shown = if left { (limit - used).max(0.0) } else { used };
        return format!("{} / {}{suffix}", format_cost(shown), format_cost(limit));
    }
    format!("{}{suffix}", format_percent(fill_percent(window, left) / 100.0))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProblemAction {
    Retry,
    /// A retry could not help; the provider's site still shows the limits.
    Dashboard,
}

pub fn problem_line(error: &QuotaError, now: f64, retry_at: Option<f64>) -> (String, ProblemAction) {
    match error.kind {
        QuotaErrorKind::NoCredentials | QuotaErrorKind::Expired => (error.message.clone(), ProblemAction::Retry),
        QuotaErrorKind::Auth => (format!("{}. Sign in again with that tool.", error.message), ProblemAction::Retry),
        QuotaErrorKind::RateLimited => match retry_at.filter(|at| *at > now) {
            Some(at) => (
                format!("Rate limited by the provider, retrying in {}", format_duration(at - now)),
                ProblemAction::Dashboard,
            ),
            None => ("Rate limited by the provider".into(), ProblemAction::Retry),
        },
        QuotaErrorKind::Network => ("Could not reach the service".into(), ProblemAction::Retry),
        QuotaErrorKind::InvalidResponse => ("Limits unavailable right now".into(), ProblemAction::Retry),
    }
}

/// Floored, unlike a countdown: 61 s ago is "1m ago", not "2m".
fn format_ago(age: f64) -> String {
    if age < 60_000.0 {
        "just now".into()
    } else {
        format!("{} ago", format_duration((age / 60_000.0).floor() * 60_000.0))
    }
}

pub fn format_updated(clock: &Clock, updated_at: Option<&str>, now: f64) -> String {
    updated_at
        .map_or_else(|| "Not updated yet".into(), |at| format!("Updated {}", format_ago(now - parse_ms(clock, at))))
}

/// How old the oldest limits are; `updatedAt` also advances on local usage reads, which work offline.
pub fn freshness_line(clock: &Clock, state: &AppState, now: f64) -> String {
    if let Some(at) = state.quota_updated_at.as_deref() {
        return format_updated(clock, Some(at), now);
    }
    let expected: Vec<&ProviderState> = state
        .providers
        .iter()
        .filter(|p| p.quota_error.as_ref().is_none_or(|e| e.kind != QuotaErrorKind::NoCredentials))
        .collect();
    if !expected.is_empty() && expected.iter().all(|p| p.quota_error.is_some()) {
        "Limits unavailable".into()
    } else {
        format_updated(clock, state.updated_at.as_deref(), now)
    }
}

pub fn refresh_outcome(state: &AppState) -> String {
    let failed: Vec<&str> =
        state.providers.iter().filter(|p| p.quota_error.is_some()).map(|p| p.label.as_str()).collect();
    let mut problems = Vec::new();
    if state.usage_error.is_some() {
        problems.push("usage could not be read".to_owned());
    }
    if !failed.is_empty() {
        problems.push(format!("{} limits unavailable", failed.join(", ")));
    }
    if problems.is_empty() {
        "Usage updated".into()
    } else {
        format!("Refresh finished, {}", problems.join(", "))
    }
}

/// Points for a small spend curve in a `width` × `height` box.
#[expect(
    clippy::cast_precision_loss,
    reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
)]
pub fn sparkline(values: &[f64], width: f64, height: f64, pad: f64) -> Option<Vec<(f64, f64)>> {
    let max = values.iter().copied().fold(0.0, f64::max);
    if values.len() < 2 || max <= 0.0 {
        return None;
    }
    let steps = (values.len() - 1) as f64;
    Some(
        values
            .iter()
            .enumerate()
            .map(|(i, v)| {
                (pad + (i as f64 * (width - pad * 2.0)) / steps, height - pad - (v / max) * (height - pad * 2.0))
            })
            .collect(),
    )
}

/// How current a machine's numbers are: this one reads its logs live, others are as of their last sync.
pub fn sync_status(clock: &Clock, machine: &MachineUsage, now: f64) -> (String, bool) {
    let at = parse_ms(clock, &machine.last_updated);
    if at.is_nan() {
        return if machine.current { ("Live · not synced yet".into(), false) } else { ("Never synced".into(), true) };
    }
    let ago = format_ago((now - at).max(0.0));
    if machine.current {
        return (format!("Live · synced {ago}"), false);
    }
    #[expect(clippy::cast_possible_truncation, reason = "the value is rounded and bounded to the target range first")]
    let stale = Timestamp::from_millisecond(now as i64)
        .is_ok_and(|now| aitrack_core::data::stale_sync::is_stale_sync(clock, &machine.last_updated, now));
    (format!("Synced {ago}{}", if stale { " · stale" } else { "" }), stale)
}

/// "09:42 PM" on that machine's clock, or nothing when it shares this one's zone.
#[expect(clippy::cast_possible_truncation, reason = "the value is rounded and bounded to the target range first")]
pub fn zone_clock(clock: &Clock, timezone: &str, now: f64) -> Option<String> {
    if timezone.is_empty() || clock.zone().iana_name() == Some(timezone) {
        return None;
    }
    let zone = TimeZone::get(timezone).ok()?;
    let local = Timestamp::from_millisecond(now as i64).ok()?.to_zoned(zone);
    let hour = local.hour();
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    Some(format!("{twelve:02}:{:02}\u{202f}{}", local.minute(), if hour < 12 { "AM" } else { "PM" }))
}

pub fn by_cost_then_tokens(a: &Spend, b: &Spend) -> std::cmp::Ordering {
    b.cost_usd.total_cmp(&a.cost_usd).then(b.tokens.total_cmp(&a.tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock() -> Clock {
        Clock::with_zone(None, TimeZone::UTC)
    }

    fn ms(text: &str) -> f64 {
        #[expect(
            clippy::cast_precision_loss,
            reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
        )]
        let value = text.parse::<Timestamp>().unwrap().as_millisecond() as f64;
        value
    }

    const HOUR: f64 = 3_600_000.0;

    fn period(cost: f64) -> PeriodUsage {
        PeriodUsage { tokens: cost * 1000.0, cost_usd: cost, has_cost: cost > 0.0, ..PeriodUsage::default() }
    }

    fn usage(daily: &[f64], today: f64) -> ProviderUsage {
        let sum: f64 = daily.iter().sum();
        ProviderUsage {
            today: period(today),
            yesterday: period(0.0),
            last7_days: period(7.5),
            last30_days: period(sum),
            all_time: period(sum + 10.0),
            daily: daily
                .iter()
                .enumerate()
                .map(|(i, c)| DailyUsage {
                    date: format!("2026-05-{:02}", i + 1),
                    cost_usd: *c,
                    has_unpriced_tokens: false,
                })
                .collect(),
        }
    }

    fn provider(key: &str, label: &str, usage: Option<ProviderUsage>) -> ProviderState {
        ProviderState {
            key: key.into(),
            label: label.into(),
            quota: None,
            quota_error: None,
            retry_at: None,
            usage,
            refreshing: false,
        }
    }

    fn state(providers: Vec<ProviderState>) -> AppState {
        AppState {
            providers,
            refreshing: false,
            machines: None,
            account_usage: None,
            projects: None,
            usage_error: None,
            updated_at: None,
            usage_updated_at: None,
            quota_updated_at: None,
            usage_empty: None,
            pull_error: None,
            syncing: false,
            sync_result: None,
        }
    }

    fn window(used: f64) -> QuotaWindow {
        QuotaWindow {
            id: "w".into(),
            label: "W".into(),
            used_percent: used,
            resets_at: None,
            period_seconds: 0.0,
            format: QuotaFormat::Percent,
            used_value: None,
            limit_value: None,
        }
    }

    fn error(kind: QuotaErrorKind, message: &str) -> QuotaError {
        QuotaError::new(kind, message)
    }

    #[test]
    fn reads_each_period_and_totals_spend() {
        let claude = usage(&[1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 3.0], 3.0);
        assert!((period_value(Some(&claude), Period::Today).cost_usd - 3.0).abs() < f64::EPSILON);
        assert!((period_value(Some(&claude), Period::Month).cost_usd - 13.0).abs() < f64::EPSILON);
        assert!((period_value(Some(&claude), Period::All).cost_usd - 23.0).abs() < f64::EPSILON);
        assert!(period_spend(None, Period::Week).is_none());
        assert_eq!(spend_label(&Spend::default()), "$0.00");
        assert_eq!(spend_label(&Spend { tokens: 500.0, ..Spend::default() }), "—");
        let zero = usage(&[0.0], 0.0);
        let total = total_spend([Some(&claude), None, Some(&zero)], Period::Today);
        assert_eq!(total, Spend { cost_usd: 3.0, tokens: 3000.0, has_cost: true, has_unpriced_tokens: false });
    }

    #[test]
    fn combines_daily_series_and_keeps_the_latest_days() {
        let combined = combined_daily([Some(&usage(&[1.0, 2.0], 0.0)), Some(&usage(&[3.0], 0.0)), None], 30);
        let pairs: Vec<(&str, f64)> = combined.iter().map(|d| (d.date.as_str(), d.cost_usd)).collect();
        assert_eq!(pairs, [("2026-05-01", 4.0), ("2026-05-02", 2.0)]);
        let last: Vec<f64> =
            combined_daily([Some(&usage(&[1.0, 2.0, 3.0], 0.0))], 2).iter().map(|d| d.cost_usd).collect();
        assert_eq!(last, [2.0, 3.0]);
    }

    #[test]
    fn stacks_history_by_provider_and_groups_it_by_monday_start_week() {
        let providers = [
            provider("claude_code", "Claude Code", Some(usage(&[1.0, 2.0, 3.0, 4.0], 1.0))),
            provider("codex", "Codex", Some(usage(&[1.0, 0.0, 0.0, 0.0], 1.0))),
        ];
        let days = build_history(&providers, 30, Bucket::Day);
        assert_eq!(days.bars.len(), 4);
        assert!((days.total_usd - 11.0).abs() < f64::EPSILON);
        assert!((days.average_usd - 2.75).abs() < f64::EPSILON);
        assert_eq!(
            (days.from.as_str(), days.to.as_str(), days.busiest.as_str()),
            ("2026-05-01", "2026-05-04", "2026-05-04")
        );
        assert!((days.peak_usd - 4.0).abs() < f64::EPSILON);
        assert_eq!(days.by_provider.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["claude_code", "codex"]);
        assert_eq!(days.bars[0].parts.len(), 2);
        let weeks = build_history(&providers, 30, Bucket::Week);
        let bars: Vec<(&str, f64)> = weeks.bars.iter().map(|b| (b.start.as_str(), b.total_usd)).collect();
        assert_eq!(bars, [("2026-04-27", 7.0), ("2026-05-04", 4.0)]);
        let two_days = build_history(&providers, 2, Bucket::Day);
        let recent: Vec<&str> = two_days.bars.iter().map(|b| b.start.as_str()).collect();
        assert_eq!(recent, ["2026-05-03", "2026-05-04"]);
        assert_eq!(build_history(&[], 30, Bucket::Day), History::default());
    }

    #[test]
    fn splits_dollars_from_cents_and_shows_sub_cent_as_not_free() {
        assert_eq!(split_amount(115.7), ("$115".into(), ".70".into()));
        assert_eq!(split_amount(4246.62), ("$4,246".into(), ".62".into()));
        assert_eq!(split_amount(0.004), ("<$0.01".into(), String::new()));
        assert_eq!(format_cost(0.004), "<$0.01");
    }

    #[test]
    fn draws_a_sparkline_or_nothing_without_data() {
        assert_eq!(sparkline(&[0.0, 5.0, 10.0], 112.0, 36.0, 3.0), Some(vec![(3.0, 33.0), (56.0, 18.0), (109.0, 3.0)]));
        assert_eq!(sparkline(&[0.0, 0.0], 112.0, 36.0, 3.0), None);
        assert_eq!(sparkline(&[4.0], 112.0, 36.0, 3.0), None);
    }

    #[test]
    fn formats_durations_and_reset_times() {
        let clock = clock();
        let now = ms("2026-06-01T12:00:00Z");
        assert_eq!(format_duration(30_000.0), "1m");
        assert_eq!(format_duration(2.0 * HOUR + 14.0 * 60_000.0), "2h 14m");
        assert_eq!(format_duration(2.0 * HOUR), "2h");
        assert_eq!(format_duration(3.0 * 24.0 * HOUR + 5.0 * HOUR), "3d 5h");
        assert_eq!(format_reset(&clock, Some("2026-06-01T14:00:00Z"), now, false).unwrap(), "Resets 2:00\u{202f}PM");
        assert_eq!(format_reset(&clock, Some("2026-06-01T14:00:00Z"), now, true).unwrap(), "Resets in 2h");
        assert_eq!(format_reset(&clock, Some("2026-06-01T12:00:30Z"), now, true).unwrap(), "Resets soon");
        assert_eq!(
            format_reset(&clock, Some("2026-06-01T03:00:00Z"), now, false).unwrap(),
            "Reset passed, waiting for new data"
        );
        assert_eq!(format_reset(&clock, None, now, true), None);
    }

    #[test]
    fn labels_the_pace_in_plain_words() {
        let zone = clock().zone().clone();
        let now = ms("2026-06-01T12:00:00Z");
        let pace = |severity, run_out_at| PaceProjection {
            severity,
            projected_used_percent: None,
            even_pace_percent: None,
            run_out_at,
        };
        assert_eq!(pace_label(&pace(PaceSeverity::Level, None), now, &zone), None);
        assert_eq!(pace_label(&pace(PaceSeverity::Healthy, None), now, &zone).unwrap(), "On pace");
        assert_eq!(pace_label(&pace(PaceSeverity::Close, None), now, &zone).unwrap(), "Tight");
        assert_eq!(pace_label(&pace(PaceSeverity::RunningOut, None), now, &zone).unwrap(), "Will run out");
        assert_eq!(
            pace_label(&pace(PaceSeverity::RunningOut, Some(now + HOUR)), now, &zone).unwrap(),
            "Runs out 1:00\u{202f}PM"
        );
        assert_eq!(pace_label(&pace(PaceSeverity::Spent, None), now, &zone).unwrap(), "Limit reached");
    }

    #[test]
    fn shows_the_value_as_used_or_left() {
        let percent = window(30.4);
        assert_eq!(format_limit_value(&percent, false), "30%");
        assert_eq!(format_limit_value(&percent, true), "70% left");
        assert!((fill_percent(&percent, true) - 69.6).abs() < 1e-9);
        let dollars = QuotaWindow {
            format: QuotaFormat::Dollars,
            used_value: Some(12.5),
            limit_value: Some(50.0),
            ..window(30.4)
        };
        assert_eq!(format_limit_value(&dollars, false), "$12.50 / $50.00");
        assert_eq!(format_limit_value(&dollars, true), "$37.50 / $50.00 left");
        assert_eq!(format_limit_value(&QuotaWindow { used_value: Some(0.0), ..dollars }, false), "$0.00 / $50.00");
    }

    #[test]
    fn shows_what_fixes_a_sign_in_problem_and_offers_only_what_can_work() {
        let now = ms("2026-06-01T12:00:00Z");
        let line = |kind, message: &str, retry_at| problem_line(&error(kind, message), now, retry_at);
        assert_eq!(
            line(QuotaErrorKind::NoCredentials, "No Codex login found. Run `codex login`.", None),
            ("No Codex login found. Run `codex login`.".into(), ProblemAction::Retry)
        );
        assert_eq!(
            line(QuotaErrorKind::Auth, "Codex rejected the saved login (HTTP 401)", None).0,
            "Codex rejected the saved login (HTTP 401). Sign in again with that tool."
        );
        assert_eq!(
            line(QuotaErrorKind::RateLimited, "x", Some(now + 3_120_000.0)),
            ("Rate limited by the provider, retrying in 52m".into(), ProblemAction::Dashboard)
        );
        assert_eq!(line(QuotaErrorKind::RateLimited, "x", Some(now - 1.0)).1, ProblemAction::Retry);
        assert_eq!(line(QuotaErrorKind::Network, "x", None).0, "Could not reach the service");
        assert_eq!(line(QuotaErrorKind::InvalidResponse, "x", None).1, ProblemAction::Retry);
    }

    #[test]
    fn dates_the_footer_by_the_limits_and_formats_its_age() {
        let clock = clock();
        let now = ms("2026-06-01T12:00:00Z");
        assert_eq!(format_updated(&clock, Some("2026-06-01T11:59:55Z"), now), "Updated just now");
        assert_eq!(format_updated(&clock, Some("2026-06-01T11:57:00Z"), now), "Updated 3m ago");
        assert_eq!(format_updated(&clock, Some("2026-06-01T11:58:59Z"), now), "Updated 1m ago");
        assert_eq!(format_updated(&clock, None, now), "Not updated yet");
        let failing = ProviderState {
            quota_error: Some(error(QuotaErrorKind::Network, "x")),
            ..provider("codex", "Codex", None)
        };
        let signed_out = ProviderState {
            quota_error: Some(error(QuotaErrorKind::NoCredentials, "x")),
            ..provider("codex", "Codex", None)
        };
        let mut app = state(vec![failing]);
        app.updated_at = Some("2026-06-01T12:00:00Z".into());
        app.quota_updated_at = Some("2026-06-01T03:00:00Z".into());
        assert_eq!(freshness_line(&clock, &app, now), "Updated 9h ago");
        app.quota_updated_at = None;
        assert_eq!(freshness_line(&clock, &app, now), "Limits unavailable");
        app.providers = vec![signed_out];
        assert_eq!(freshness_line(&clock, &app, now), "Updated just now");
    }

    #[test]
    fn tells_a_real_zero_from_usage_it_does_not_have() {
        let mut app = state(vec![provider("codex", "Codex", None)]);
        assert_eq!(usage_availability(&state(vec![])), Availability::Off);
        assert_eq!(usage_availability(&app), Availability::Loading);
        app.usage_error = Some("x".into());
        assert_eq!(usage_availability(&app), Availability::Failed);
        app.refreshing = true;
        assert_eq!(usage_availability(&app), Availability::Loading);
        app.usage_error = None;
        app.usage_empty = Some(true);
        assert_eq!(usage_availability(&app), Availability::Empty);
        app.providers[0].usage = Some(usage(&[1.0], 1.0));
        app.usage_empty = None;
        app.usage_error = Some("x".into());
        assert_eq!(usage_availability(&app), Availability::Ready);
        assert_eq!(
            empty_usage_guidance(&["Codex", "Cursor"]),
            "Use Codex or Cursor, then refresh. To add your other machines, run `npx aitrack init`."
        );
        assert_eq!(or_list(&["A", "B", "C"]), "A, B, or C");
    }

    #[test]
    fn says_how_a_refresh_ended() {
        let ok = state(vec![provider("codex", "Codex", None)]);
        assert_eq!(refresh_outcome(&ok), "Usage updated");
        let failed = state(vec![ProviderState {
            quota_error: Some(error(QuotaErrorKind::Network, "x")),
            ..provider("codex", "Codex", None)
        }]);
        assert_eq!(refresh_outcome(&failed), "Refresh finished, Codex limits unavailable");
    }

    #[test]
    fn writes_numbers_tokens_and_days_in_en_us() {
        let tokens: Vec<String> =
            [12.0, 1234.0, 1_234_567.0, 2_500_000_000.0].iter().map(|n| format_tokens(*n)).collect();
        assert_eq!(tokens, ["12", "1.2K", "1.2M", "2.50B"]);
        assert_eq!(format_day("2026-03-08"), "Mar 8");
        assert_eq!(format_day("2026-12-31"), "Dec 31");
        assert_eq!(format_number(1234.5), "1,234.5");
        assert_eq!(format_number(12.0), "12");
        assert_eq!(format_percent(0.125), "13%");
    }

    #[test]
    fn marks_partial_days_and_shares_by_cost_while_anything_is_priced() {
        let day = |cost, unpriced| DailyUsage { date: "x".into(), cost_usd: cost, has_unpriced_tokens: unpriced };
        assert_eq!(day_cost_label(&day(2.0, false)), "$2.00");
        assert_eq!(day_cost_label(&day(2.0, true)), "$2.00 (partial)");
        assert_eq!(day_cost_label(&day(0.0, true)), "Not priced");
        let priced = Spend { tokens: 10.0, cost_usd: 3.0, has_cost: true, has_unpriced_tokens: false };
        let unpriced = Spend { tokens: 90.0, ..Spend::default() };
        assert!((ShareBasis::new([&priced, &unpriced]).total - 3.0).abs() < f64::EPSILON);
        assert!((ShareBasis::new([&unpriced]).total - 90.0).abs() < f64::EPSILON);
    }

    #[test]
    fn says_how_current_a_machine_is_and_shows_another_zones_clock_only() {
        let clock = clock();
        let now = ms("2026-06-01T12:00:00Z");
        let machine = |current, last: &str| MachineUsage {
            name: "m".into(),
            timezone: String::new(),
            last_updated: last.into(),
            current,
            providers: indexmap::IndexMap::new(),
        };
        assert_eq!(sync_status(&clock, &machine(true, ""), now), ("Live · not synced yet".into(), false));
        assert_eq!(sync_status(&clock, &machine(false, ""), now), ("Never synced".into(), true));
        assert_eq!(
            sync_status(&clock, &machine(true, "2026-05-27T12:00:00Z"), now),
            ("Live · synced 5d 0h ago".into(), false)
        );
        assert_eq!(sync_status(&clock, &machine(false, "2026-06-01T10:00:00Z"), now), ("Synced 2h ago".into(), false));
        assert!(sync_status(&clock, &machine(false, "2026-05-28T11:00:00Z"), now).1);
        assert_eq!(zone_clock(&clock, "UTC", now), None);
        assert_eq!(zone_clock(&clock, "", now), None);
        assert_eq!(zone_clock(&clock, "Not/AZone", now), None);
        assert_eq!(zone_clock(&clock, "Asia/Tokyo", now).unwrap(), "09:00\u{202f}PM");
    }

    #[test]
    fn levels_a_heatmap_cell_by_its_share_of_the_peak() {
        assert_eq!([0.0, 5.0, 20.0, 50.0, 100.0].map(|v| intensity_level(v, 100.0)), [0, 1, 2, 3, 4]);
        assert_eq!(intensity_level(5.0, 0.0), 0);
    }
}
