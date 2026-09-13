//! Usage data loading and merging.

use super::day_map::add_token_counts;
use super::types::{DayEntry, MachineFile, ProviderData, ProviderDay};

pub use super::empty_state::{usage_empty_message, usage_empty_window_message};

/// Merge one provider-day record into the running accumulator for that day.
pub fn merge_provider_day(
    rec: &mut DayEntry,
    _provider_key: &str,
    p_data: &ProviderDay,
    _date: Option<&str>,
) {
    // Add token fields directly to day entry
    rec.input_tokens += p_data.totals.input_tokens;
    rec.output_tokens += p_data.totals.output_tokens;
    if let Some(raw) = p_data.totals.raw_input_tokens {
        *rec.raw_input_tokens.get_or_insert(0) += raw;
    }
    if let Some(cached) = p_data.totals.cached_input_tokens {
        *rec.cached_input_tokens.get_or_insert(0) += cached;
    }
    if let Some(cache_create) = p_data.totals.cache_creation_input_tokens {
        *rec.cache_creation_input_tokens.get_or_insert(0) += cache_create;
    }

    let mut summed_model_cost = 0.0;
    let backfilled_model_cost = 0.0;
    let mut is_any_model_had_cost = false;

    for (model, counts) in &p_data.by_model {
        let m = rec.by_model.entry(model.clone()).or_default();
        let mut temp_model_counts = counts.clone();
        temp_model_counts.cost_usd = None;
        add_token_counts(m, &temp_model_counts);

        // Cost resolution would happen here via pricing module
        // For now, just use stored cost if available
        if let Some(cost) = counts.cost_usd {
            *m.cost_usd.get_or_insert(0.0) += cost;
            summed_model_cost += cost;
            is_any_model_had_cost = true;
        }
    }

    // Calculate day cost
    let day_cost = if let Some(totals_cost) = p_data.totals.cost_usd {
        Some(totals_cost + backfilled_model_cost)
    } else if is_any_model_had_cost {
        Some(summed_model_cost)
    } else {
        None
    };

    if let Some(cost) = day_cost {
        *rec.cost_usd.get_or_insert(0.0) += cost;
    }
}

#[derive(Debug, Clone, Default)]
pub struct LoadOptions {
    pub providers: Option<Vec<String>>,
    pub refresh_live: bool,
}

#[derive(Debug, Clone)]
pub struct LoadedUsageData {
    pub provider_data: ProviderData,
    pub machines: Vec<MachineFile>,
}

/// Load merged provider data from all available sources.
/// This is a stub that will be fully implemented when readers are complete.
pub fn load_merged_provider_data(_options: &LoadOptions) -> anyhow::Result<LoadedUsageData> {
    // Stub implementation - will be completed with readers module
    Ok(LoadedUsageData {
        provider_data: ProviderData::new(),
        machines: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::types::TokenCounts;

    #[test]
    fn test_merge_provider_day() {
        let mut rec = DayEntry::new();
        let mut by_model = std::collections::HashMap::new();
        by_model.insert(
            "test-model".to_string(),
            TokenCounts {
                input_tokens: 100,
                output_tokens: 50,
                cost_usd: Some(0.5),
                ..Default::default()
            },
        );

        let p_data = ProviderDay {
            by_model,
            totals: TokenCounts {
                input_tokens: 100,
                output_tokens: 50,
                cost_usd: Some(0.5),
                ..Default::default()
            },
        };

        merge_provider_day(&mut rec, "test", &p_data, None);
        assert_eq!(rec.input_tokens, 100);
        assert_eq!(rec.output_tokens, 50);
    }
}
