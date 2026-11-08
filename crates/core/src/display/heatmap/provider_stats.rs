use serde::Serialize;

use super::stats::{PeakMonth, current_streak, longest_streak, peak_month};
use crate::data::aggregate::sum_day_map;
use crate::data::types::DayMap;
use crate::day::Day;

/// One provider's headline numbers, unformatted; each renderer formats them.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStats {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    /// False when no day carried a cost, shown as an em dash.
    pub has_cost: bool,
    /// Days with at least one token.
    pub active_days: u64,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub peak_month: Option<PeakMonth>,
}

pub fn provider_stats(days: &DayMap, today: Day) -> ProviderStats {
    let totals = sum_day_map(days);
    ProviderStats {
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        total_tokens: totals.input_tokens + totals.output_tokens,
        cost_usd: totals.cost_usd,
        has_cost: totals.has_cost,
        active_days: totals.days,
        current_streak: current_streak(days, today),
        longest_streak: longest_streak(days),
        peak_month: peak_month(days),
    }
}
