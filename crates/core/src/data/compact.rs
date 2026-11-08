use indexmap::IndexMap;

use crate::data::types::{MachineDays, ProviderDay};
use crate::day::Day;
use crate::pricing::cost::{PriceMode, resolve_model_cost};
use crate::pricing::model_pricing::ModelPricing;

/// The single `byModel` row of a compacted day; older versions need `byModel` to sum to the totals.
pub const COMPACTED_MODEL: &str = "(compacted)";

/// A row that stands for several models, so there is no model to name or to price.
pub fn is_synthetic_model(model: &str) -> bool {
    model == COMPACTED_MODEL || model == crate::data::project::ALL_MODELS
}

pub fn is_compacted_day(day: &ProviderDay) -> bool {
    day.by_model.len() == 1 && day.by_model.contains_key(COMPACTED_MODEL)
}

fn compact_provider_day(pricing: &ModelPricing, provider: &str, date: Day, day: &ProviderDay) -> ProviderDay {
    if is_compacted_day(day) {
        return day.clone();
    }
    let mut totals = day.totals.clone();
    if totals.cost_usd.is_none() {
        // Pricing the models now keeps the day's cost once they are gone.
        let date = date.to_string();
        let costs: Vec<Option<f64>> = day
            .by_model
            .iter()
            .map(|(model, counts)| {
                resolve_model_cost(pricing, provider, model, counts, Some(&date), PriceMode::Merge, None)
            })
            .collect();
        if !costs.is_empty() && costs.iter().all(Option::is_some) {
            totals.set_cost(costs.iter().flatten().fold(0.0, |sum, cost| sum + cost));
        } else if totals.input_tokens + totals.output_tokens > 0 {
            totals.has_unpriced_tokens = Some(true);
        }
    }
    ProviderDay {
        by_model: IndexMap::from([(COMPACTED_MODEL.to_owned(), totals.clone())]),
        totals,
        // Small, and the only place a compacted day keeps its projects.
        by_project: day.by_project.clone(),
        by_cwd: None,
    }
}

/// Days before `today` minus `after_days` keep per-provider totals only.
pub fn compact_days(pricing: &ModelPricing, days: &MachineDays, after_days: u64, today: Day) -> MachineDays {
    let cutoff = today.shift(-i64::try_from(after_days).unwrap_or(i64::MAX / 2).min(3_650_000));
    days.iter()
        .map(|(date, providers)| {
            let providers = if *date >= cutoff {
                providers.clone()
            } else {
                providers
                    .iter()
                    .map(|(key, day)| (key.clone(), compact_provider_day(pricing, key, *date, day)))
                    .collect()
            };
            (*date, providers)
        })
        .collect()
}
