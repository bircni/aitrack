//! Cost per model, per provider. Formulas keep 4.x's term order: sync commits on any change in the last bit.

use std::collections::BTreeSet;
use std::sync::Mutex;

use super::model_pricing::ModelPricing;
use super::rates::{CACHE_READ_RATE_MULTIPLIER, FullRates, TokenBuckets, cost_from_rates, scale_rates, token_buckets};
use super::supplement::{ClaudePricing, CodexPricing};
use crate::data::model_id::{
    CLAUDE_FAMILIES, canonical_model_id, canonicalize_claude_model_id, strip_claude_tier_suffix,
};
use crate::data::types::TokenCounts;
use crate::js::locale_compare;

/// Models priced by a family fallback, whose rate can be off by a tier, so they are reported.
#[derive(Default, Debug)]
pub struct FallbackCollector(Mutex<BTreeSet<String>>);

impl FallbackCollector {
    pub fn record(&self, model: &str) {
        self.0.lock().expect("not poisoned").insert(model.to_owned());
    }

    /// The recorded ids in `localeCompare` order, clearing them.
    pub fn drain(&self) -> Vec<String> {
        let mut ids: Vec<String> = std::mem::take(&mut *self.0.lock().expect("not poisoned")).into_iter().collect();
        ids.sort_by(|a, b| locale_compare(a, b));
        ids
    }
}

fn record(fallbacks: Option<&FallbackCollector>, id: &str) {
    if let Some(fallbacks) = fallbacks {
        fallbacks.record(id);
    }
}

pub fn lookup_claude_pricing(pricing: &ModelPricing, model: &str, usage_date: Option<&str>) -> Option<ClaudePricing> {
    pricing.lookup_claude(&canonicalize_claude_model_id(model), usage_date)
}

pub fn find_claude_pricing(
    pricing: &ModelPricing,
    model: &str,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> Option<ClaudePricing> {
    if let Some(exact) = lookup_claude_pricing(pricing, model, usage_date) {
        return Some(exact);
    }
    let id = canonicalize_claude_model_id(model);
    let base = strip_claude_tier_suffix(&id);
    if base != id {
        // A tier with no published rate, like fast mode on a retired model: the base rate, flagged as a guess.
        record(fallbacks, &id);
        return find_claude_pricing(pricing, base, usage_date, fallbacks);
    }
    if let Some(rates) = pricing.lookup_catalog_claude(&id) {
        return Some(rates);
    }
    // An id that names no family stays unpriced rather than guessed as Sonnet.
    let family = CLAUDE_FAMILIES.iter().find(|family| id.contains(*family))?;
    record(fallbacks, &id);
    pricing.claude_family_fallback(family)
}

/// 1-hour writes cost twice the base input rate, even for models whose cache hits are not 0.1x.
#[allow(clippy::cast_precision_loss)]
fn claude_cost(pricing: &ClaudePricing, tokens: &TokenBuckets, one_hour: u64) -> f64 {
    cost_from_rates(&pricing.rates(), tokens) + (one_hour as f64 * pricing.input_per_million * 2.0) / 1_000_000.0
}

#[allow(clippy::cast_precision_loss)]
pub fn estimate_claude_cost_from_aggregate(
    pricing: &ModelPricing,
    model: &str,
    input: u64,
    output: u64,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> Option<f64> {
    let rates = find_claude_pricing(pricing, model, usage_date, fallbacks)?;
    let tokens = TokenBuckets { raw: input as f64, output: output as f64, cache_read: 0.0, cache_write: 0.0 };
    Some(claude_cost(&rates, &tokens, 0))
}

pub fn estimate_claude_cost_from_stored_counts(
    pricing: &ModelPricing,
    model: &str,
    counts: &TokenCounts,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> Option<f64> {
    let has_breakdown = counts.raw_input_tokens.is_some()
        || counts.cached_input_tokens.is_some()
        || counts.cache_creation_input_tokens.is_some()
        || counts.cache_creation_1h_input_tokens.is_some();
    if !has_breakdown {
        return None;
    }
    let rates = find_claude_pricing(pricing, model, usage_date, fallbacks)?;
    Some(claude_cost(&rates, &token_buckets(counts), counts.cache_creation_1h_input_tokens.unwrap_or(0)))
}

pub fn lookup_codex_pricing(pricing: &ModelPricing, model: &str, usage_date: Option<&str>) -> Option<CodexPricing> {
    pricing.lookup_codex(&canonical_model_id(model), usage_date)
}

pub fn find_codex_pricing(
    pricing: &ModelPricing,
    model: &str,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> Option<CodexPricing> {
    if let Some(exact) = lookup_codex_pricing(pricing, model, usage_date) {
        return Some(exact);
    }
    let id = canonical_model_id(model);
    if let Some(rates) = pricing.lookup_catalog_codex(&id) {
        return Some(rates);
    }
    let fallback = pricing.codex_family_fallback(&id)?;
    record(fallbacks, &id);
    Some(fallback)
}

/// Not `cost_from_rates`: its term order moves the last bit, and sync commits on any byte change.
#[allow(clippy::cast_precision_loss)]
pub fn estimate_codex_cost(
    pricing: &ModelPricing,
    model: &str,
    input: u64,
    output: u64,
    cached: u64,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> Option<f64> {
    let p = find_codex_pricing(pricing, model, usage_date, fallbacks)?;
    let fresh = input.saturating_sub(cached) as f64;
    let cached = cached.min(input) as f64;
    Some(
        (fresh * p.input_per_million
            + cached * p.input_per_million * CACHE_READ_RATE_MULTIPLIER
            + output as f64 * p.output_per_million)
            / 1_000_000.0,
    )
}

fn lookup_exact_cursor_rates(pricing: &ModelPricing, model: &str, usage_date: Option<&str>) -> Option<FullRates> {
    // No public catalogs here: Cursor slugs missing from the tables stay unpriced on purpose.
    pricing
        .lookup_cursor_native(model)
        .or_else(|| lookup_claude_pricing(pricing, model, usage_date).map(|p| p.rates()))
        .or_else(|| lookup_codex_pricing(pricing, model, usage_date).map(|p| p.rates()))
}

pub fn resolve_cursor_rates(pricing: &ModelPricing, model: &str, usage_date: Option<&str>) -> Option<FullRates> {
    let aliased = pricing.apply_cursor_alias(model);
    if let Some(exact) = lookup_exact_cursor_rates(pricing, aliased, usage_date) {
        return Some(exact);
    }
    let base = aliased.strip_suffix("-fast").filter(|base| !base.is_empty())?;
    let base_rates = lookup_exact_cursor_rates(pricing, base, usage_date)?;
    Some(scale_rates(&base_rates, pricing.cursor_fast_multiplier(base)?))
}

pub fn estimate_cursor_cost(
    pricing: &ModelPricing,
    model: &str,
    counts: &TokenCounts,
    usage_date: Option<&str>,
) -> Option<f64> {
    resolve_cursor_rates(pricing, model, usage_date).map(|rates| cost_from_rates(&rates, &token_buckets(counts)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriceMode {
    /// Keep a stored cost; price only what has none.
    Merge,
    /// Price again from the counts, for `recompute-costs`.
    Recompute,
}

/// One model's cost on a day, or `None` when it cannot be priced. The caller applies the merge short-circuit.
pub fn price_model_cost(
    pricing: &ModelPricing,
    provider: &str,
    model: &str,
    counts: &TokenCounts,
    usage_date: Option<&str>,
    mode: PriceMode,
    fallbacks: Option<&FallbackCollector>,
) -> Option<f64> {
    match provider {
        "claude_code" => {
            let stored = estimate_claude_cost_from_stored_counts(pricing, model, counts, usage_date, fallbacks);
            if mode == PriceMode::Recompute {
                return stored;
            }
            stored.or_else(|| {
                estimate_claude_cost_from_aggregate(
                    pricing,
                    model,
                    counts.input_tokens,
                    counts.output_tokens,
                    usage_date,
                    fallbacks,
                )
            })
        }
        "codex" => estimate_codex_cost(
            pricing,
            model,
            counts.input_tokens,
            counts.output_tokens,
            counts.cached_input_tokens.unwrap_or(0),
            usage_date,
            fallbacks,
        ),
        "cursor" => estimate_cursor_cost(pricing, model, counts, usage_date),
        _ => None,
    }
}

/// A stored cost in merge mode, otherwise the provider's price.
pub fn resolve_model_cost(
    pricing: &ModelPricing,
    provider: &str,
    model: &str,
    counts: &TokenCounts,
    usage_date: Option<&str>,
    mode: PriceMode,
    fallbacks: Option<&FallbackCollector>,
) -> Option<f64> {
    if mode == PriceMode::Merge && counts.cost_usd.is_some() {
        return counts.cost_usd;
    }
    price_model_cost(pricing, provider, model, counts, usage_date, mode, fallbacks)
}
