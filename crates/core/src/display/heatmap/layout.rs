use crate::data::day_map::{filter_day_map_by_year, merge_all_day_maps};
use crate::data::types::ProviderData;
use crate::providers::active_provider_keys;

/// The day maps to draw and their keys in drawing order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProviderLayout {
    pub data: ProviderData,
    pub keys: Vec<String>,
}

/// Providers with no day in `year` are dropped.
#[must_use]
pub fn filter_provider_data_by_year(data: &ProviderData, year: i16) -> ProviderData {
    data.iter()
        .map(|(key, days)| (key.clone(), filter_day_map_by_year(days, year)))
        .filter(|(_, days)| !days.is_empty())
        .collect()
}

#[must_use]
pub fn resolve_provider_layout(data: &ProviderData, all: bool, year: Option<i16>) -> ProviderLayout {
    let filtered = year.map_or_else(|| data.clone(), |year| filter_provider_data_by_year(data, year));
    if all {
        let merged = merge_all_day_maps(filtered.values());
        if merged.is_empty() {
            return ProviderLayout::default();
        }
        return ProviderLayout { data: ProviderData::from([("all".to_owned(), merged)]), keys: vec!["all".to_owned()] };
    }
    let keys = active_provider_keys(&filtered);
    ProviderLayout { data: filtered, keys }
}
