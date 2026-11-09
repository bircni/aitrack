//! `recompute-costs`: price stored model-days again, keeping what cannot be repriced.

use super::cost::{FallbackCollector, PriceMode, resolve_model_cost};
use super::model_pricing::ModelPricing;
use crate::data::compact::COMPACTED_MODEL;
use crate::data::types::{MachineDays, ProviderDay, TokenCounts};
use crate::store::validate::approximately_equal;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RepriceResult {
    /// Whether any stored cost was replaced.
    pub touched: bool,
    /// Claude model-days left alone because they predate the cache breakdown.
    pub legacy_skipped: usize,
}

/// Providers whose rows are written to git, in display order.
const SYNCED_PROVIDERS: [&str; 2] = ["claude_code", "codex"];

const fn token_sum(counts: &TokenCounts) -> u64 {
    counts.input_tokens + counts.output_tokens
}

/// A project has no model split to reprice from, so its cost follows the day's change, but only when
/// the projects cover the whole day; otherwise each one's share is unknown.
fn rescale_project_costs(day: &mut ProviderDay, previous_total: Option<f64>) -> bool {
    let (Some(previous), Some(total)) = (previous_total, day.totals.cost_usd) else { return false };
    let Some(projects) = day.by_project.as_mut() else { return false };
    if previous <= 0.0 || approximately_equal(previous, total) {
        return false;
    }
    if projects.values().map(token_sum).sum::<u64>() != token_sum(&day.totals) {
        return false;
    }
    let factor = total / previous;
    for counts in projects.values_mut() {
        if let Some(cost) = counts.cost_usd.as_mut() {
            *cost *= factor;
        }
    }
    true
}

/// Recompute model and day costs, ignoring float noise from summed reader estimates.
fn reprice_provider_day(
    pricing: &ModelPricing,
    provider: &str,
    date: &str,
    day: &mut ProviderDay,
    fallbacks: Option<&FallbackCollector>,
) -> RepriceResult {
    let mut day_total = 0.0;
    let mut model_count = 0;
    let mut cost_complete = true;
    let mut result = RepriceResult::default();
    let previous_total = day.totals.cost_usd;
    for (model, counts) in &mut day.by_model {
        model_count += 1;
        if model == COMPACTED_MODEL {
            // The models are gone, so the stored cost cannot be repriced.
            match counts.cost_usd {
                Some(cost) => day_total += cost,
                None => cost_complete = false,
            }
            continue;
        }
        let Some(cost) =
            resolve_model_cost(pricing, provider, model, counts, Some(date), PriceMode::Recompute, fallbacks)
        else {
            match counts.cost_usd {
                Some(stored) => {
                    day_total += stored;
                    if provider == "claude_code" {
                        result.legacy_skipped += 1;
                    }
                }
                None => cost_complete = false,
            }
            continue;
        };
        if counts.cost_usd.is_none_or(|stored| !approximately_equal(stored, cost))
            || counts.has_unpriced_tokens == Some(true)
        {
            counts.set_cost(cost);
            counts.clear_unpriced();
            result.touched = true;
        }
        day_total += cost;
    }
    if day.totals.has_unpriced_tokens == Some(true)
        && !day.by_model.values().any(|c| c.has_unpriced_tokens == Some(true))
    {
        day.totals.clear_unpriced();
        result.touched = true;
    }
    // A day total is only safe to re-derive once every model in it has a cost.
    if model_count > 0
        && cost_complete
        && day.totals.cost_usd.is_none_or(|total| !approximately_equal(total, day_total))
    {
        day.totals.set_cost(day_total);
        result.touched = true;
    }
    if rescale_project_costs(day, previous_total) {
        result.touched = true;
    }
    result
}

/// Reprices every synced provider-day in a machine file, in place.
pub fn reprice_machine_days(
    pricing: &ModelPricing,
    days: &mut MachineDays,
    fallbacks: Option<&FallbackCollector>,
) -> RepriceResult {
    let mut total = RepriceResult::default();
    for (date, providers) in days.iter_mut() {
        let date = date.to_string();
        for provider in SYNCED_PROVIDERS {
            if let Some(day) = providers.get_mut(provider) {
                let result = reprice_provider_day(pricing, provider, &date, day, fallbacks);
                total.touched |= result.touched;
                total.legacy_skipped += result.legacy_skipped;
            }
        }
    }
    total
}
