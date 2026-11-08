use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::catalog::{Catalog, ModelRates, find_catalog_rates};
use super::rates::{CACHE_READ_RATE_MULTIPLIER, FullRates};
use super::supplement::{ClaudePricing, CodexPricing, Overrides, Supplement, compile_pattern};
use crate::Locked;

/// First-party rates and overrides, with catalog gap filling for Claude and Codex.
pub struct ModelPricing {
    pub supplement: Supplement,
    primary: Catalog,
    secondary: Catalog,
    aliases: Vec<(regex_lite::Regex, String)>,
    codex_fallbacks: Vec<(regex_lite::Regex, CodexPricing)>,
    fingerprint: String,
    /// Readers price per message, so a model missing from the tables would rescan the catalogs each time.
    catalog_lookups: Mutex<HashMap<(&'static str, String), Option<ModelRates>>>,
}

fn pick_override<P: Copy>(overrides: &Overrides<P>, id: &str, usage_date: Option<&str>) -> Option<P> {
    let date = usage_date?;
    overrides.get(id)?.iter().find(|entry| date < entry.before.as_str()).map(|entry| entry.pricing)
}

impl ModelPricing {
    #[must_use]
    pub fn new(supplement: Supplement, primary: Catalog, secondary: Catalog) -> Self {
        let aliases = supplement
            .cursor
            .aliases
            .iter()
            .filter_map(|rule| Some((compile_pattern(&rule.pattern).ok()?, rule.canonical.clone())))
            .collect();
        let codex_fallbacks = supplement
            .codex
            .family_fallback
            .iter()
            .filter_map(|rule| {
                let pricing = CodexPricing {
                    input_per_million: rule.input_per_million,
                    output_per_million: rule.output_per_million,
                };
                Some((compile_pattern(&rule.pattern).ok()?, pricing))
            })
            .collect();
        let fingerprint = fingerprint(&supplement, &primary, &secondary);
        Self {
            supplement,
            primary,
            secondary,
            aliases,
            codex_fallbacks,
            fingerprint,
            catalog_lookups: Mutex::default(),
        }
    }

    /// Changes with any effective rate, but not with the daily pack timestamps.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn updated_at(&self) -> &str {
        &self.supplement.updated_at
    }

    pub fn apply_cursor_alias<'a>(&'a self, model: &'a str) -> &'a str {
        self.aliases
            .iter()
            .find(|(pattern, _)| pattern.is_match(model))
            .map_or(model, |(_, canonical)| canonical.as_str())
    }

    pub fn lookup_claude(&self, id: &str, usage_date: Option<&str>) -> Option<ClaudePricing> {
        let claude = &self.supplement.claude;
        pick_override(&claude.overrides, id, usage_date).or_else(|| claude.models.get(id).copied())
    }

    pub fn claude_family_fallback(&self, family: &str) -> Option<ClaudePricing> {
        self.supplement.claude.family_fallback.get(family).copied()
    }

    pub fn lookup_codex(&self, id: &str, usage_date: Option<&str>) -> Option<CodexPricing> {
        let codex = &self.supplement.codex;
        pick_override(&codex.overrides, id, usage_date)
            .or_else(|| codex.current.get(id).copied())
            .or_else(|| codex.historical.get(id).copied())
    }

    pub fn codex_family_fallback(&self, id: &str) -> Option<CodexPricing> {
        self.codex_fallbacks.iter().find(|(pattern, _)| pattern.is_match(id)).map(|(_, pricing)| *pricing)
    }

    pub fn lookup_cursor_native(&self, id: &str) -> Option<FullRates> {
        self.supplement.cursor.models.get(id).copied()
    }

    pub fn cursor_fast_multiplier(&self, base: &str) -> Option<f64> {
        self.supplement.cursor.fast_multipliers.get(base).copied()
    }

    fn catalog_rates(&self, id: &str, provider: &'static str) -> Option<ModelRates> {
        let key = (provider, id.to_owned());
        if let Some(known) = self.catalog_lookups.locked().get(&key) {
            return *known;
        }
        let found = find_catalog_rates(&self.primary, id, &[provider])
            .or_else(|| find_catalog_rates(&self.secondary, id, &[provider]));
        self.catalog_lookups.locked().insert(key, found);
        found
    }

    /// Claude rates from the catalogs when the supplement has no row.
    pub fn lookup_catalog_claude(&self, id: &str) -> Option<ClaudePricing> {
        let rates = self.catalog_rates(id, "anthropic")?;
        Some(ClaudePricing {
            input_per_million: rates.input,
            output_per_million: rates.output,
            cache_read_per_million: if rates.cache_read_explicit {
                rates.cache_read
            } else {
                rates.input * CACHE_READ_RATE_MULTIPLIER
            },
            cache_create_per_million: if rates.cache_write_explicit { rates.cache_write } else { rates.input * 1.25 },
        })
    }

    /// Codex rates from the catalogs when the supplement has no row.
    pub fn lookup_catalog_codex(&self, id: &str) -> Option<CodexPricing> {
        let rates = self.catalog_rates(id, "openai")?;
        Some(CodexPricing { input_per_million: rates.input, output_per_million: rates.output })
    }
}

/// SHA-256 of the effective rates as canonical JSON: every object's keys sorted.
#[expect(
    clippy::expect_used,
    reason = "map keys are strings or dates and the output is an in-memory buffer, so serializing cannot fail"
)]
fn fingerprint(supplement: &Supplement, primary: &Catalog, secondary: &Catalog) -> String {
    fn canonical(value: Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut entries: Vec<(String, Value)> = map.into_iter().collect();
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                Value::Object(entries.into_iter().map(|(k, v)| (k, canonical(v))).collect())
            }
            Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
            other @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => other,
        }
    }
    let mut rates = supplement.clone();
    rates.updated_at.clear();
    rates.comment = None;
    let value = serde_json::json!([rates, primary.entries, secondary.entries]);
    let digest = Sha256::digest(serde_json::to_string(&canonical(value)).expect("serializes").as_bytes());
    crate::hex(&digest)
}
