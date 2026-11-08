//! Compact `LiteLLM` and `models.dev` catalogs, which fill gaps in the first-party tables.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::time::Clock;

/// One model's catalog rates, per million tokens.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRates {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
    /// False when cache reads were defaulted (0.1x input), not published.
    pub cache_read_explicit: bool,
    /// False when cache writes were defaulted, not published.
    pub cache_write_explicit: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Catalog {
    pub entries: IndexMap<String, ModelRates>,
}

/// `{ retrievedAt, models: { key: { i, o, cw, cr, ia?, oa?, cwa?, cra?, fast?, cre?, cwe? } } }`, validated.
pub fn parse_compact_catalog(value: &Value) -> Option<Catalog> {
    let retrieved = value.get("retrievedAt")?.as_str()?;
    Clock::system().parse_timestamp(retrieved)?;
    let models = value.get("models")?.as_object()?;
    if models.is_empty() {
        return None;
    }
    let amount = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|x| x.is_finite() && *x >= 0.0);
    let mut entries = IndexMap::with_capacity(models.len());
    for (key, row) in models {
        let row = row.as_object()?;
        let (i, o, cw, cr) =
            (amount(row.get("i"))?, amount(row.get("o"))?, amount(row.get("cw"))?, amount(row.get("cr"))?);
        for optional in ["ia", "oa", "cwa", "cra", "fast"] {
            if row.get(optional).is_some() && amount(row.get(optional)).is_none() {
                return None;
            }
        }
        for flag in ["cre", "cwe"] {
            if row.get(flag).is_some_and(|f| !f.is_boolean()) {
                return None;
            }
        }
        let explicit = |flag: &str| row.get(flag).and_then(Value::as_bool) != Some(false);
        entries.insert(
            key.clone(),
            ModelRates {
                input: i,
                output: o,
                cache_write: cw,
                cache_read: cr,
                cache_read_explicit: explicit("cre"),
                cache_write_explicit: explicit("cwe"),
            },
        );
    }
    Some(Catalog { entries })
}

/// Prefer first-party provider keys when both `anthropic/x` and `x` exist.
fn provider_key_rank(key: &str) -> u8 {
    if key.starts_with("anthropic/") || key.starts_with("openai/") || key.starts_with("cursor/") {
        0
    } else if key.starts_with("xai/") || key.starts_with("google/") {
        1
    } else if key.contains('/') {
        3
    } else {
        2
    }
}

fn key_matches_providers(key: &str, providers: &[&str]) -> bool {
    providers.iter().any(|p| key.starts_with(&format!("{p}/")) || key.starts_with(&format!("vercel_ai_gateway/{p}/")))
}

/// A bare key is only trusted when every qualified `.../modelId` owner is an allowed provider.
fn bare_alias_allowed(catalog: &Catalog, model_id: &str, providers: &[&str]) -> bool {
    let suffix = format!("/{model_id}");
    catalog.entries.keys().filter(|key| key.ends_with(&suffix)).all(|key| key_matches_providers(key, providers))
}

pub fn find_catalog_rates(catalog: &Catalog, model_id: &str, providers: &[&str]) -> Option<ModelRates> {
    let allowed = |key: &str| {
        if key.contains('/') {
            key_matches_providers(key, providers)
        } else {
            bare_alias_allowed(catalog, model_id, providers)
        }
    };
    let mut hits: Vec<(&str, ModelRates)> = Vec::new();
    let candidates = std::iter::once(model_id.to_owned()).chain(providers.iter().map(|p| format!("{p}/{model_id}")));
    for key in candidates {
        if let Some((key, rates)) = catalog.entries.get_key_value(&key)
            && allowed(key)
        {
            hits.push((key, *rates));
        }
    }
    if hits.is_empty() {
        let suffix = format!("/{model_id}");
        for (key, rates) in &catalog.entries {
            if key.ends_with(&suffix) && allowed(key) {
                hits.push((key, *rates));
            }
        }
    }
    // Stable, as Array.prototype.sort is.
    hits.sort_by_key(|(key, _)| (provider_key_rank(key), key.encode_utf16().count()));
    hits.first().map(|(_, rates)| *rates)
}
