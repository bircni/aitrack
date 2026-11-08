//! `usage` reports and comparisons, windowed in each machine's own timezone.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::BTreeSet;

use indexmap::IndexMap;
use jiff::Timestamp;
use serde::Serialize;

use crate::data::aggregate::{DateFilter, aggregate_models};
use crate::data::compact::is_synthetic_model;
use crate::data::empty_state::{usage_empty_message, usage_empty_window_message};
use crate::data::project_usage::{ProjectBreakdown, ProjectSelector, aggregate_projects, project_provider_data};
use crate::data::sort::compare_by_cost_then_tokens;
use crate::data::types::ProviderData;
use crate::data::usage_data::{ZonedUsageData, ZonedUsageSource, provider_data_for_windows};
use crate::data::usage_periods::{PeriodArgs, UsagePeriod, UsageWindow, all_time, locale_now_label};
use crate::day::Day;
use crate::display::format::fmt;
use crate::js::locale_compare;
use crate::pricing::model_pricing::ModelPricing;
use crate::providers::{ordered_provider_keys, provider_label};
use crate::time::{Clock, UNKNOWN_TIMEZONE, calendar_date_in_zone};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportOptions {
    pub period: UsagePeriod,
    pub args: PeriodArgs,
    /// Only this project's usage; a project has no model split, so each provider is one row.
    pub project: Option<ProjectSelector>,
}

/// What a project-scoped report leaves out or cannot see, in words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UsageProjectScope {
    pub label: String,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReportRow {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tokens: u64,
    /// The part of the input that hit a prompt cache.
    pub cached_input_tokens: u64,
    pub has_cached: bool,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub has_cost: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReportProvider {
    pub key: String,
    pub label: String,
    pub rows: Vec<UsageReportRow>,
    pub subtotal_tokens: u64,
    #[serde(rename = "subtotalCostUSD")]
    pub subtotal_cost_usd: f64,
    pub subtotal_has_cost: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReportTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tokens: u64,
    pub cached_input_tokens: u64,
    pub has_cached: bool,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub has_cost: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_unpriced_tokens: bool,
    /// Models whose usage could not be priced, sorted and de-duplicated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unpriced_models: Option<Vec<String>>,
}

/// In the key order 4.x builds the object: the project scope, then the timezone note.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub window_label: String,
    pub providers: Vec<UsageReportProvider>,
    pub totals: UsageReportTotals,
    pub row_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<UsageProjectScope>,
    /// Set when a relative window was evaluated in more than one timezone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone_note: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageComparisonMetric {
    pub current: f64,
    pub previous: f64,
    pub delta: f64,
    pub percent_change: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelComparison {
    pub provider_key: String,
    pub provider_label: String,
    pub model: String,
    pub tokens: UsageComparisonMetric,
    #[serde(rename = "costUSD")]
    pub cost_usd: UsageComparisonMetric,
    pub has_cost: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageComparisonTotals {
    pub tokens: UsageComparisonMetric,
    #[serde(rename = "costUSD")]
    pub cost_usd: UsageComparisonMetric,
    pub has_cost: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageComparison {
    pub previous_window_label: String,
    pub totals: UsageComparisonTotals,
    pub models: Vec<UsageModelComparison>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UsageComparisonReport {
    pub current: UsageReport,
    pub previous: UsageReport,
    pub comparison: UsageComparison,
}

/// The viewer's calendar and clock, read once per report.
pub struct ReportContext<'a> {
    pub pricing: &'a ModelPricing,
    pub clock: &'a Clock,
    pub now: Timestamp,
}

impl ReportContext<'_> {
    fn viewer_today(&self) -> Day {
        calendar_date_in_zone(self.clock.zone_name(), self.now).unwrap_or_else(|| self.clock.local_day(self.now))
    }

    fn today_for_zone(&self, zone: &str) -> Day {
        calendar_date_in_zone(zone, self.now).unwrap_or_else(|| self.viewer_today())
    }

    fn window(&self, options: &ReportOptions, today: Day) -> Result<UsageWindow, String> {
        options.period.window(today, &locale_now_label(self.now, self.clock.zone()), options.args)
    }

    fn previous(&self, options: &ReportOptions, today: Day) -> Result<UsageWindow, String> {
        options.period.previous(today, &self.window(options, today)?)
    }
}

/// The viewer's zone, then every other recorded machine zone; empty when there are no others.
#[must_use]
pub fn machine_zones(viewer: &str, sources: &[ZonedUsageSource]) -> Vec<String> {
    let mut others: Vec<String> = Vec::new();
    for source in sources {
        let zone = &source.timezone;
        if !zone.is_empty() && zone != UNKNOWN_TIMEZONE && zone != viewer && !others.contains(zone) {
            others.push(zone.clone());
        }
    }
    if others.is_empty() {
        return others;
    }
    std::iter::once(viewer.to_owned()).chain(others).collect()
}

/// Other machines' zones, when a relative window has to follow more than one.
#[must_use]
pub fn timezone_window_note(viewer: &str, sources: &[ZonedUsageSource], period: UsagePeriod) -> Option<String> {
    if !period.anchors_on_today() {
        return None;
    }
    let zones = machine_zones(viewer, sources);
    (!zones.is_empty()).then(|| format!("This window follows each machine's own timezone ({}).", zones.join(", ")))
}

enum Kind {
    Current,
    Previous,
}

fn windowed_provider_data<'a>(
    context: &ReportContext<'_>,
    loaded: &'a ZonedUsageData,
    options: &ReportOptions,
    kind: &Kind,
) -> Result<(Cow<'a, ProviderData>, UsageWindow), String> {
    let label_today = context.viewer_today();
    let label_window = match kind {
        Kind::Current => context.window(options, label_today)?,
        Kind::Previous => context.previous(options, label_today)?,
    };
    // Each source's window is then the viewer's, so the loader's merge already holds the data.
    if loaded.zoned_sources.iter().all(|s| context.today_for_zone(&s.timezone) == label_today) {
        return Ok((Cow::Borrowed(&loaded.provider_data), label_window));
    }
    let failure = std::cell::RefCell::new(None);
    let data = provider_data_for_windows(context.pricing, loaded, context.clock.zone_name(), |zone| {
        let today = context.today_for_zone(zone);
        let window = match kind {
            Kind::Current => context.window(options, today),
            Kind::Previous => context.previous(options, today),
        };
        window.map_or_else(
            |error| {
                failure.replace(Some(error));
                all_time()
            },
            |w| (w.start, w.end),
        )
    });
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    // Already clipped per zone, so the label window must not clip again.
    let (start, end) = all_time();
    Ok((Cow::Owned(data), UsageWindow { start, end, label: label_window.label }))
}

const fn filter_of(window: &UsageWindow) -> DateFilter {
    DateFilter { start: Some(window.start), end: Some(window.end), year: None }
}

fn project_scope(
    selector: &ProjectSelector,
    data: &ProviderData,
    window: &UsageWindow,
    sources: &[ZonedUsageSource],
) -> UsageProjectScope {
    let mut notes = vec!["Cursor usage is not attributed to projects and is excluded.".to_owned()];
    match selector {
        ProjectSelector::Dir(_) => notes.push(
            "This folder has no git remote: matched by working directory on this machine only, so other machines are not included."
                .to_owned(),
        ),
        ProjectSelector::Project(_) if sources.len() > 1 => {
            notes.push("Other machines count only for days they synced with project data.".to_owned());
        }
        ProjectSelector::Project(_) => {}
    }
    let unattributed = aggregate_projects(data, &filter_of(window)).unattributed.map_or(0, |u| u.tokens);
    if unattributed > 0 {
        #[expect(
            clippy::cast_precision_loss,
            reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
        )]
        let tokens = fmt(unattributed as f64);
        notes.push(format!(
            "{tokens} tokens in this window are not attributed to any project (synced before projects were recorded) and are not included."
        ));
    }
    UsageProjectScope { label: selector.label(), notes }
}

fn scoped_data<'a>(data: &'a ProviderData, options: &ReportOptions) -> Cow<'a, ProviderData> {
    match &options.project {
        Some(selector) => Cow::Owned(project_provider_data(data, selector)),
        None => Cow::Borrowed(data),
    }
}

fn report_from_data(
    context: &ReportContext<'_>,
    loaded: &ZonedUsageData,
    data: &ProviderData,
    window: &UsageWindow,
    options: &ReportOptions,
) -> UsageReport {
    let mut report = build_report(&scoped_data(data, options), window);
    report.project =
        options.project.as_ref().map(|selector| project_scope(selector, data, window, &loaded.zoned_sources));
    report.timezone_note = timezone_window_note(context.clock.zone_name(), &loaded.zoned_sources, options.period);
    report
}

fn build_report(data: &ProviderData, window: &UsageWindow) -> UsageReport {
    let mut providers = Vec::new();
    let mut totals = UsageReportTotals::default();
    let mut row_count = 0;
    let mut unpriced: BTreeSet<String> = BTreeSet::new();
    for key in ordered_provider_keys(data) {
        let Some(days) = data.get(&key) else { continue };
        let mut rows = Vec::new();
        let (mut subtotal_tokens, mut subtotal_cost, mut subtotal_has_cost, mut has_unpriced) = (0, 0.0, false, false);
        for (model, agg) in aggregate_models(days, &filter_of(window)) {
            let tokens = agg.input_tokens + agg.output_tokens;
            has_unpriced |= agg.has_unpriced_tokens;
            if agg.has_unpriced_tokens && !is_synthetic_model(&model) {
                unpriced.insert(model.clone());
            }
            subtotal_tokens += tokens;
            totals.input_tokens += agg.input_tokens;
            totals.output_tokens += agg.output_tokens;
            if agg.has_cached {
                totals.cached_input_tokens += agg.cached_input_tokens;
                totals.has_cached = true;
            }
            if agg.has_cost {
                subtotal_cost += agg.cost_usd;
                subtotal_has_cost = true;
                totals.cost_usd += agg.cost_usd;
                totals.has_cost = true;
            }
            rows.push(UsageReportRow {
                model,
                input_tokens: agg.input_tokens,
                output_tokens: agg.output_tokens,
                tokens,
                cached_input_tokens: agg.cached_input_tokens,
                has_cached: agg.has_cached,
                cost_usd: if agg.has_cost { agg.cost_usd } else { 0.0 },
                has_cost: agg.has_cost,
                has_unpriced_tokens: agg.has_unpriced_tokens,
            });
        }
        totals.has_unpriced_tokens |= has_unpriced;
        if rows.is_empty() {
            continue;
        }
        rows.sort_by(|a, b| compare_by_cost_then_tokens(a.cost_usd, a.tokens, b.cost_usd, b.tokens));
        row_count += rows.len();
        providers.push(UsageReportProvider {
            label: provider_label(&key).to_owned(),
            key,
            rows,
            subtotal_tokens,
            subtotal_cost_usd: subtotal_cost,
            subtotal_has_cost,
            has_unpriced_tokens: has_unpriced,
        });
    }
    totals.tokens = totals.input_tokens + totals.output_tokens;
    if !unpriced.is_empty() {
        totals.unpriced_models = Some(unpriced.into_iter().collect());
    }
    UsageReport { window_label: window.label.clone(), providers, totals, row_count, project: None, timezone_note: None }
}

fn metric(current: f64, previous: f64) -> UsageComparisonMetric {
    UsageComparisonMetric {
        current,
        previous,
        delta: current - previous,
        percent_change: (previous != 0.0).then(|| ((current - previous) / previous) * 100.0),
    }
}

fn rows_by_provider_and_model(report: &UsageReport) -> IndexMap<(String, String), &UsageReportRow> {
    report.providers.iter().flat_map(|p| p.rows.iter().map(|r| ((p.key.clone(), r.model.clone()), r))).collect()
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
)]
fn compare_reports(current: &UsageReport, previous: &UsageReport) -> UsageComparison {
    let (current_rows, previous_rows) = (rows_by_provider_and_model(current), rows_by_provider_and_model(previous));
    let mut keys: Vec<&(String, String)> = current_rows.keys().collect();
    keys.extend(previous_rows.keys().filter(|k| !current_rows.contains_key(*k)));
    let mut models: Vec<UsageModelComparison> = keys
        .into_iter()
        .map(|key| {
            let (now, before) = (current_rows.get(key), previous_rows.get(key));
            let tokens = |row: Option<&&UsageReportRow>| row.map_or(0.0, |r| r.tokens as f64);
            let cost = |row: Option<&&UsageReportRow>| row.map_or(0.0, |r| r.cost_usd);
            UsageModelComparison {
                provider_key: key.0.clone(),
                provider_label: provider_label(&key.0).to_owned(),
                model: key.1.clone(),
                tokens: metric(tokens(now), tokens(before)),
                cost_usd: metric(cost(now), cost(before)),
                has_cost: now.is_some_and(|r| r.has_cost) || before.is_some_and(|r| r.has_cost),
                has_unpriced_tokens: now.is_some_and(|r| r.has_unpriced_tokens)
                    || before.is_some_and(|r| r.has_unpriced_tokens),
            }
        })
        .collect();
    models.sort_by(|a, b| {
        b.cost_usd
            .delta
            .abs()
            .partial_cmp(&a.cost_usd.delta.abs())
            .unwrap_or(Ordering::Equal)
            .then(b.tokens.delta.abs().partial_cmp(&a.tokens.delta.abs()).unwrap_or(Ordering::Equal))
            .then_with(|| {
                locale_compare(&format!("{}\0{}", a.provider_key, a.model), &format!("{}\0{}", b.provider_key, b.model))
            })
    });
    UsageComparison {
        previous_window_label: previous.window_label.clone(),
        totals: UsageComparisonTotals {
            tokens: metric(current.totals.tokens as f64, previous.totals.tokens as f64),
            cost_usd: metric(current.totals.cost_usd, previous.totals.cost_usd),
            has_cost: current.totals.has_cost || previous.totals.has_cost,
            has_unpriced_tokens: current.totals.has_unpriced_tokens || previous.totals.has_unpriced_tokens,
        },
        models,
    }
}

/// One window's report from data already loaded, so several windows share one read.
pub fn build_usage_report(
    context: &ReportContext<'_>,
    loaded: &ZonedUsageData,
    options: &ReportOptions,
) -> Result<UsageReport, String> {
    let (data, window) = windowed_provider_data(context, loaded, options, &Kind::Current)?;
    Ok(report_from_data(context, loaded, &data, &window, options))
}

/// Per-project usage for the same windows, and so the same numbers, as the reports.
pub fn build_project_breakdown(
    context: &ReportContext<'_>,
    loaded: &ZonedUsageData,
    options: &ReportOptions,
) -> Result<ProjectBreakdown, String> {
    let (data, window) = windowed_provider_data(context, loaded, options, &Kind::Current)?;
    Ok(aggregate_projects(&data, &filter_of(&window)))
}

pub fn build_usage_comparison(
    context: &ReportContext<'_>,
    loaded: &ZonedUsageData,
    options: &ReportOptions,
) -> Result<UsageComparisonReport, String> {
    let (current_data, current_window) = windowed_provider_data(context, loaded, options, &Kind::Current)?;
    let (previous_data, previous_window) = windowed_provider_data(context, loaded, options, &Kind::Previous)?;
    let current = report_from_data(context, loaded, &current_data, &current_window, options);
    let previous = build_report(&scoped_data(&previous_data, options), &previous_window);
    let comparison = compare_reports(&current, &previous);
    Ok(UsageComparisonReport { current, previous, comparison })
}

/// Why a report has nothing to show, or `None` when it does.
#[must_use]
pub fn empty_report_message(
    report: Option<&UsageReport>,
    not_configured: bool,
    providers: &[String],
) -> Option<String> {
    match report {
        None => Some(usage_empty_message(not_configured, providers)),
        Some(report) if report.row_count == 0 => Some(usage_empty_window_message(Some(&report.window_label))),
        Some(_) => None,
    }
}
