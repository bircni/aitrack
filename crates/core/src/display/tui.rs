//! `aitrack show --tui`: one stats row per provider and a total when there are several.

use serde::Serialize;

use super::format::{fmt, fmt_usd_cost};
use super::heatmap::layout::resolve_provider_layout;
use super::heatmap::provider_stats::provider_stats;
use super::heatmap::stats::format_month_label;
use super::style::{self, BOLD, DIM};
use super::terminal_table::{Align, Column, TableOptions, default_table_style, render_table};
use crate::data::aggregate::sum_day_map;
use crate::data::day_map::merge_all_day_maps;
use crate::data::types::{DayMap, ProviderData};
use crate::day::Day;
use crate::providers::{cost_column_label, provider_label};
use crate::time::Clock;

pub type TuiOptions = super::render_options::RenderOptions;

/// As `--tui --json` writes it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsRow {
    pub provider: String,
    pub days: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(rename = "costUSD")]
    pub cost_usd: Option<f64>,
    pub current_streak: Option<u64>,
    pub longest_streak: Option<u64>,
    pub peak_month: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TuiStats {
    pub rows: Vec<StatsRow>,
    /// The all-provider total when there are several.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer: Option<StatsRow>,
    pub keys: Vec<String>,
}

fn summarize(days: &DayMap, key: &str, today: Day) -> StatsRow {
    let stats = provider_stats(days, today);
    StatsRow {
        provider: provider_label(key).to_owned(),
        days: stats.active_days,
        input_tokens: stats.input_tokens,
        output_tokens: stats.output_tokens,
        total_tokens: stats.total_tokens,
        cost_usd: stats.has_cost.then_some(stats.cost_usd),
        current_streak: Some(stats.current_streak),
        longest_streak: Some(stats.longest_streak),
        peak_month: stats.peak_month.map(|p| p.month),
    }
}

/// Merged first so a day two providers shared counts once; streaks and peak month are per provider, so blank.
fn total_row<'a>(maps: impl IntoIterator<Item = &'a DayMap>) -> StatsRow {
    let totals = sum_day_map(&merge_all_day_maps(maps));
    StatsRow {
        provider: "TOTAL".to_owned(),
        days: totals.days,
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        total_tokens: totals.input_tokens + totals.output_tokens,
        cost_usd: totals.has_cost.then_some(totals.cost_usd),
        current_streak: None,
        longest_streak: None,
        peak_month: None,
    }
}

#[must_use]
pub fn tui_stats(data: &ProviderData, options: &TuiOptions) -> TuiStats {
    tui_stats_at(data, options, Clock::system().today())
}

#[must_use]
pub fn tui_stats_at(data: &ProviderData, options: &TuiOptions, today: Day) -> TuiStats {
    let layout = resolve_provider_layout(data, options.all, options.year);
    if options.all {
        let rows = layout.data.get("all").filter(|d| !d.is_empty()).map(|d| summarize(d, "all", today));
        return TuiStats { rows: rows.into_iter().collect(), footer: None, keys: layout.keys };
    }
    let present: Vec<(&String, &DayMap)> =
        layout.keys.iter().filter_map(|key| layout.data.get(key).map(|d| (key, d))).collect();
    let rows: Vec<StatsRow> = present.iter().map(|(key, days)| summarize(days, key, today)).collect();
    let footer = (rows.len() > 1).then(|| total_row(present.iter().map(|(_, d)| *d)));
    TuiStats { rows, footer, keys: layout.keys }
}

#[must_use]
pub fn render_tui(data: &ProviderData, options: &TuiOptions) -> String {
    render_tui_at(data, options, Clock::system().today(), style::enabled())
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
)]
fn cells(row: &StatsRow) -> Vec<String> {
    let dash = || "—".to_owned();
    vec![
        row.provider.clone(),
        row.days.to_string(),
        fmt(row.input_tokens as f64),
        fmt(row.output_tokens as f64),
        fmt(row.total_tokens as f64),
        row.cost_usd.map_or_else(dash, fmt_usd_cost),
        match (row.current_streak, row.longest_streak) {
            (Some(current), Some(longest)) => format!("{current} / {longest}"),
            _ => dash(),
        },
        row.peak_month.as_deref().map_or_else(dash, format_month_label),
    ]
}

pub fn render_tui_at(data: &ProviderData, options: &TuiOptions, today: Day, color: bool) -> String {
    let stats = tui_stats_at(data, options, today);
    if stats.rows.is_empty() {
        return String::new();
    }
    let style = default_table_style(options.dark);
    let title = match options.year {
        None => BOLD.paint("aitrack stats", color),
        Some(year) => BOLD.paint(&format!("aitrack stats ({year})"), color),
    };
    let subtitle = DIM.paint("Streak = current / longest (days)", color);
    let cost_header = match stats.keys.as_slice() {
        [only] => cost_column_label(only, false),
        _ => "Est. cost".to_owned(),
    };
    let column = |header, align| Column { header, align };
    let columns = [
        column("Provider", Align::Left),
        column("Days", Align::Right),
        column("Input", Align::Right),
        column("Output", Align::Right),
        column("Total", Align::Right),
        column(&cost_header, Align::Right),
        column("Streak", Align::Right),
        column("Peak month", Align::Left),
    ];
    let rows: Vec<Vec<String>> = stats.rows.iter().map(cells).collect();
    let footer = stats.footer.as_ref().map(cells);
    let table = render_table(
        &columns,
        &rows,
        &TableOptions {
            style,
            color,
            footer: footer.as_deref(),
            footer_style: None,
            first_column_style: Some(style.header),
        },
    );
    [title, subtitle, String::new(), table].join("\n")
}
