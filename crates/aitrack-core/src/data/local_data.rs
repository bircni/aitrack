//! Local data building and merging utilities.

use super::types::{CURRENT_SCHEMA_VERSION, MachineFile, ProviderData, ProviderDay, TokenCounts};
use crate::timezone::machine_timezone;
use std::collections::HashMap;

pub use crate::timezone::machine_timezone as local_timezone;

fn token_count_fields(counts: &TokenCounts) -> TokenCounts {
    TokenCounts {
        input_tokens: counts.input_tokens,
        output_tokens: counts.output_tokens,
        cached_input_tokens: counts.cached_input_tokens,
        raw_input_tokens: counts.raw_input_tokens,
        cache_creation_input_tokens: counts.cache_creation_input_tokens,
        cost_usd: counts.cost_usd,
    }
}

pub fn build_machine_data(machine_id: &str, all_providers: &ProviderData) -> MachineFile {
    let mut days: HashMap<String, HashMap<String, ProviderDay>> = HashMap::new();

    for (provider_key, day_map) in all_providers {
        for (date, day) in day_map {
            let date_entry = days.entry(date.clone()).or_default();

            let mut by_model: HashMap<String, TokenCounts> = HashMap::new();
            for (model, counts) in &day.by_model {
                by_model.insert(model.clone(), token_count_fields(counts));
            }

            let totals = TokenCounts {
                input_tokens: day.input_tokens,
                output_tokens: day.output_tokens,
                cached_input_tokens: day.cached_input_tokens,
                raw_input_tokens: day.raw_input_tokens,
                cache_creation_input_tokens: day.cache_creation_input_tokens,
                cost_usd: day.cost_usd,
            };

            date_entry.insert(provider_key.clone(), ProviderDay { by_model, totals });
        }
    }

    MachineFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        hostname: machine_id.to_string(),
        timezone: machine_timezone(),
        day_bucket: super::types::DayBucket::Local,
        last_updated: chrono::Utc::now().to_rfc3339(),
        days,
    }
}

pub fn machine_has_data(machine: &MachineFile) -> bool {
    !machine.days.is_empty()
}

fn day_tokens(day: &ProviderDay) -> u64 {
    day.totals.input_tokens + day.totals.output_tokens
}

/// Merge persisted days with fresh data, preferring fresh unless persisted has more tokens.
pub fn merge_persisted_days(
    persisted: Option<&HashMap<String, HashMap<String, ProviderDay>>>,
    fresh: &HashMap<String, HashMap<String, ProviderDay>>,
) -> HashMap<String, HashMap<String, ProviderDay>> {
    let mut all_dates = std::collections::HashSet::new();

    if let Some(p) = persisted {
        for date in p.keys() {
            all_dates.insert(date.clone());
        }
    }

    for date in fresh.keys() {
        all_dates.insert(date.clone());
    }

    let mut days: HashMap<String, HashMap<String, ProviderDay>> = HashMap::new();
    let mut sorted_dates: Vec<_> = all_dates.into_iter().collect();
    sorted_dates.sort();

    for date in sorted_dates {
        let mut providers: HashMap<String, ProviderDay> = HashMap::new();

        // Start with persisted data
        if let Some(p) = persisted {
            if let Some(persisted_providers) = p.get(&date) {
                providers.extend(
                    persisted_providers
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone())),
                );
            }
        }

        // Merge fresh data, preferring it if it has more tokens
        if let Some(fresh_providers) = fresh.get(&date) {
            for (provider_key, fresh_day) in fresh_providers {
                let should_use_fresh = providers
                    .get(provider_key)
                    .map(|persisted_day| day_tokens(fresh_day) >= day_tokens(persisted_day))
                    .unwrap_or(true);

                if should_use_fresh {
                    providers.insert(provider_key.clone(), fresh_day.clone());
                }
            }
        }

        // Sort provider keys
        let mut sorted_providers: Vec<_> = providers.into_iter().collect();
        sorted_providers.sort_by(|a, b| a.0.cmp(&b.0));
        days.insert(date, sorted_providers.into_iter().collect());
    }

    days
}

/// Read local provider maps from all providers.
pub fn read_local_provider_maps() -> anyhow::Result<ProviderData> {
    use crate::readers::{read_claude_data, read_codex_data, read_cursor_data_sync};

    let mut providers = ProviderData::new();

    // Read Claude data
    match read_claude_data(None) {
        Ok(day_map) => {
            providers.insert("claude_code".to_string(), day_map);
        }
        Err(err) => {
            eprintln!("Warning: Failed to read Claude data: {}", err);
        }
    }

    // Read Codex data
    match read_codex_data(None) {
        Ok(day_map) => {
            providers.insert("codex".to_string(), day_map);
        }
        Err(err) => {
            eprintln!("Warning: Failed to read Codex data: {}", err);
        }
    }

    // Read Cursor data (with default TTL)
    match read_cursor_data_sync(Some(
        crate::readers::cursor::DEFAULT_CURSOR_CACHE_TTL_SECONDS,
    )) {
        Ok(day_map) => {
            providers.insert("cursor".to_string(), day_map);
        }
        Err(err) => {
            eprintln!("Warning: Failed to read Cursor data: {}", err);
        }
    }

    Ok(providers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_machine_data() {
        use super::super::types::DayMap;
        let mut providers = ProviderData::new();
        let mut day_map = DayMap::new();
        let mut day = super::super::types::DayEntry::new();
        day.input_tokens = 100;
        day.output_tokens = 50;
        day_map.insert("2026-01-01".to_string(), day);
        providers.insert("claude_code".to_string(), day_map);

        let machine = build_machine_data("test-machine", &providers);
        assert_eq!(machine.hostname, "test-machine");
        assert!(machine.days.contains_key("2026-01-01"));
    }

    #[test]
    fn test_machine_has_data() {
        let machine = MachineFile::new("test".to_string(), "UTC".to_string());
        assert!(!machine_has_data(&machine));
    }
}
