use serde::Serialize;

use super::constants::INTENSITY_PERCENTILE;
use super::intensity::percentile;
use super::provider_stats::provider_stats;
use super::stats::{compute_model_stats, format_month_label, format_peak_date};
use crate::data::types::DayMap;
use crate::day::Day;
use crate::display::format::{fmt, fmt_usd_cost};
use crate::display::model_names::display_model_name;
use crate::providers::{cost_column_label, provider_label};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StatCell {
    pub label: String,
    pub value: String,
    /// A lighter second line, such as a token amount.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSectionViewModel {
    pub name: String,
    pub max_tokens: u64,
    pub header_stats: Vec<StatCell>,
    pub bottom_stats: Vec<StatCell>,
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
)]
fn tokens(n: u64) -> String {
    fmt(n as f64)
}

fn cell(label: &str, value: String, sub: Option<String>) -> StatCell {
    StatCell { label: label.to_owned(), value, sub }
}

fn days(n: u64) -> String {
    format!("{n} day{}", if n == 1 { "" } else { "s" })
}

/// Days off the grid stay out of the intensity percentile, or a busy old year washes out the visible one.
pub fn build_provider_section_view_model(
    key: &str,
    days_map: &DayMap,
    visible: impl Fn(&Day) -> bool,
    today: Day,
) -> ProviderSectionViewModel {
    let stats = provider_stats(days_map, today);
    let totals: Vec<u64> = days_map
        .iter()
        .map(|(date, e)| (date, e.counts.input_tokens + e.counts.output_tokens))
        .filter(|(date, total)| *total > 0 && visible(date))
        .map(|(_, total)| total)
        .collect();
    let max_tokens = match percentile(&totals, INTENSITY_PERCENTILE) {
        0 => 1,
        max => max,
    };
    let models = compute_model_stats(days_map, today);
    let top = |t: Option<&super::stats::ModelTop>| {
        (t.map_or_else(|| "—".to_owned(), |t| display_model_name(&t.model, false)), t.map(|t| tokens(t.tokens)))
    };
    let (all_value, all_sub) = top(models.top_all_time.as_ref());
    let (recent_value, recent_sub) = top(models.top_recent.as_ref());
    let peak = models.peak.as_ref();
    let month = stats.peak_month.as_ref();
    ProviderSectionViewModel {
        name: provider_label(key).to_owned(),
        max_tokens,
        header_stats: vec![
            cell("INPUT TOKENS", tokens(stats.input_tokens), None),
            cell("OUTPUT TOKENS", tokens(stats.output_tokens), None),
            cell("TOTAL TOKENS", tokens(stats.total_tokens), None),
            cell(
                &cost_column_label(key, true),
                if stats.has_cost { fmt_usd_cost(stats.cost_usd) } else { "—".to_owned() },
                None,
            ),
        ],
        bottom_stats: vec![
            cell("MOST USED MODEL", all_value, all_sub),
            cell("LAST 30 DAYS", recent_value, recent_sub),
            cell(
                "PEAK DAY",
                peak.map_or_else(|| "—".to_owned(), |p| format_peak_date(p.date)),
                peak.map(|p| tokens(p.tokens)),
            ),
            cell(
                "PEAK MONTH",
                month.map_or_else(|| "—".to_owned(), |m| format_month_label(&m.month)),
                month.map(|m| tokens(m.tokens)),
            ),
            cell("CURRENT STREAK", days(stats.current_streak), None),
            cell("LONGEST STREAK", days(stats.longest_streak), None),
        ],
    }
}
