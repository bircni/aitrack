//! Claude pricing tables and cost estimation.

use super::fallback::FallbackCollector;
use crate::constants::CACHE_READ_RATE_MULTIPLIER;
use crate::data::model_id::{CLAUDE_FAMILIES, canonicalize_claude_model_id};
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy)]
pub struct ClaudePricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_create_per_million: f64,
}

const REDUCED_CACHE_READ_RATE_MULTIPLIER: f64 = 0.025;

fn price_from_base(input: f64, output: f64, cache_read_rate_multiplier: f64) -> ClaudePricing {
    ClaudePricing {
        input_per_million: input,
        output_per_million: output,
        cache_read_per_million: input * cache_read_rate_multiplier,
        cache_create_per_million: input * 1.25,
    }
}

static CLAUDE_PRICING_BY_ID: LazyLock<HashMap<&'static str, ClaudePricing>> = LazyLock::new(|| {
    let mut map = HashMap::new();

    // Latest generation (Fable/Mythos tier)
    map.insert(
        "claude-fable-5-1",
        price_from_base(10.0, 50.0, REDUCED_CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-mythos-5-1",
        price_from_base(10.0, 50.0, REDUCED_CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-fable-5",
        price_from_base(10.0, 50.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-mythos-5",
        price_from_base(10.0, 50.0, CACHE_READ_RATE_MULTIPLIER),
    );

    // Current generation
    map.insert(
        "claude-opus-5",
        price_from_base(5.0, 25.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-opus-4-8",
        price_from_base(5.0, 25.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-opus-4-7",
        price_from_base(5.0, 25.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-opus-4-6",
        price_from_base(5.0, 25.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-opus-4-5",
        price_from_base(5.0, 25.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-sonnet-4-6",
        price_from_base(3.0, 15.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-sonnet-4-5",
        price_from_base(3.0, 15.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-sonnet-5",
        price_from_base(2.0, 10.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-haiku-4-5",
        price_from_base(1.0, 5.0, CACHE_READ_RATE_MULTIPLIER),
    );

    // Older / deprecated
    map.insert(
        "claude-opus-4-1",
        price_from_base(15.0, 75.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-opus-4-0",
        price_from_base(15.0, 75.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-opus-4",
        price_from_base(15.0, 75.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-sonnet-4-0",
        price_from_base(3.0, 15.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-sonnet-4",
        price_from_base(3.0, 15.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-haiku-3-5",
        price_from_base(0.8, 4.0, CACHE_READ_RATE_MULTIPLIER),
    );

    // Claude 3 generation
    map.insert(
        "claude-opus-3",
        price_from_base(15.0, 75.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-sonnet-3-7",
        price_from_base(3.0, 15.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-sonnet-3-5",
        price_from_base(3.0, 15.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-sonnet-3",
        price_from_base(3.0, 15.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "claude-haiku-3",
        price_from_base(0.25, 1.25, CACHE_READ_RATE_MULTIPLIER),
    );

    map
});

static FAMILY_FALLBACK: LazyLock<HashMap<&'static str, ClaudePricing>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "fable",
        price_from_base(10.0, 50.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "mythos",
        price_from_base(10.0, 50.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "opus",
        price_from_base(5.0, 25.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "sonnet",
        price_from_base(3.0, 15.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map.insert(
        "haiku",
        price_from_base(1.0, 5.0, CACHE_READ_RATE_MULTIPLIER),
    );
    map
});

pub fn find_claude_pricing(
    model: &str,
    _usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> ClaudePricing {
    let id = canonicalize_claude_model_id(model);

    if let Some(pricing) = CLAUDE_PRICING_BY_ID.get(id.as_str()) {
        return *pricing;
    }

    // Try family fallback
    for family in CLAUDE_FAMILIES {
        if id.contains(family) {
            if let Some(fb) = fallbacks {
                fb.record(&id);
            }
            return *FAMILY_FALLBACK.get(family).unwrap();
        }
    }

    // Unrecognized - use sonnet fallback
    if let Some(fb) = fallbacks {
        fb.record(&id);
    }
    *FAMILY_FALLBACK.get("sonnet").unwrap()
}

fn claude_cost(pricing: ClaudePricing, tokens: &ClaudeTokens) -> f64 {
    (tokens.raw * pricing.input_per_million
        + tokens.output * pricing.output_per_million
        + tokens.cache_read * pricing.cache_read_per_million
        + tokens.cache_create * pricing.cache_create_per_million)
        / 1_000_000.0
}

#[derive(Debug, Clone, Copy)]
struct ClaudeTokens {
    raw: f64,
    output: f64,
    cache_read: f64,
    cache_create: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ClaudeMessageUsage {
    pub input_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
}

pub fn estimate_claude_cost_usd(
    model: &str,
    usage: &ClaudeMessageUsage,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> f64 {
    let pricing = find_claude_pricing(model, usage_date, fallbacks);
    claude_cost(
        pricing,
        &ClaudeTokens {
            raw: usage.input_tokens.unwrap_or(0) as f64,
            output: usage.output_tokens.unwrap_or(0) as f64,
            cache_read: usage.cache_read_input_tokens.unwrap_or(0) as f64,
            cache_create: usage.cache_creation_input_tokens.unwrap_or(0) as f64,
        },
    )
}

pub fn estimate_claude_cost_from_aggregate_tokens(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> f64 {
    let pricing = find_claude_pricing(model, usage_date, fallbacks);
    claude_cost(
        pricing,
        &ClaudeTokens {
            raw: input_tokens as f64,
            output: output_tokens as f64,
            cache_read: 0.0,
            cache_create: 0.0,
        },
    )
}

pub fn claude_counts_have_cost_breakdown(counts: &ClaudeCountsBreakdown) -> bool {
    counts.raw_input_tokens.is_some()
        || counts.cached_input_tokens.is_some()
        || counts.cache_creation_input_tokens.is_some()
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ClaudeCountsBreakdown {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub raw_input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
}

pub fn estimate_claude_cost_from_stored_counts(
    model: &str,
    counts: &ClaudeCountsBreakdown,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> Option<f64> {
    if !claude_counts_have_cost_breakdown(counts) {
        return None;
    }

    let cache_read = counts.cached_input_tokens.unwrap_or(0);
    let cache_create = counts.cache_creation_input_tokens.unwrap_or(0);
    let raw = counts.raw_input_tokens.unwrap_or_else(|| {
        counts
            .input_tokens
            .saturating_sub(cache_read + cache_create)
    });

    let pricing = find_claude_pricing(model, usage_date, fallbacks);
    Some(claude_cost(
        pricing,
        &ClaudeTokens {
            raw: raw as f64,
            output: counts.output_tokens as f64,
            cache_read: cache_read as f64,
            cache_create: cache_create as f64,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_claude_pricing() {
        let pricing = find_claude_pricing("claude-opus-4-6", None, None);
        assert_eq!(pricing.input_per_million, 5.0);
        assert_eq!(pricing.output_per_million, 25.0);
    }

    #[test]
    fn test_estimate_claude_cost() {
        let usage = ClaudeMessageUsage {
            input_tokens: Some(1_000_000),
            output_tokens: Some(1_000_000),
            ..Default::default()
        };
        let cost = estimate_claude_cost_usd("claude-opus-4-6", &usage, None, None);
        assert_eq!(cost, 30.0); // 5 + 25
    }
}
