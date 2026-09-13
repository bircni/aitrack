//! Codex (OpenAI) pricing tables and cost estimation.

use super::fallback::FallbackCollector;
use crate::constants::CACHE_READ_RATE_MULTIPLIER;
use crate::data::model_id::{strip_model_effort_suffix, strip_model_version_suffixes};
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy)]
pub struct CodexPricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
}

static CODEX_PRICING_CURRENT: LazyLock<HashMap<&'static str, CodexPricing>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "gpt-6-astra",
        CodexPricing {
            input_per_million: 10.0,
            output_per_million: 50.0,
        },
    );
    map.insert(
        "gpt-5.6-sol",
        CodexPricing {
            input_per_million: 4.0,
            output_per_million: 20.0,
        },
    );
    map.insert(
        "gpt-5.6-terra",
        CodexPricing {
            input_per_million: 2.0,
            output_per_million: 12.0,
        },
    );
    map.insert(
        "gpt-5.6-luna",
        CodexPricing {
            input_per_million: 0.2,
            output_per_million: 1.2,
        },
    );
    map.insert(
        "gpt-5.5",
        CodexPricing {
            input_per_million: 5.0,
            output_per_million: 30.0,
        },
    );
    map.insert(
        "gpt-5.5-pro",
        CodexPricing {
            input_per_million: 30.0,
            output_per_million: 180.0,
        },
    );
    map.insert(
        "gpt-5.4",
        CodexPricing {
            input_per_million: 2.5,
            output_per_million: 15.0,
        },
    );
    map.insert(
        "gpt-5.4-mini",
        CodexPricing {
            input_per_million: 0.75,
            output_per_million: 4.5,
        },
    );
    map.insert(
        "gpt-5.4-nano",
        CodexPricing {
            input_per_million: 0.2,
            output_per_million: 1.25,
        },
    );
    map.insert(
        "gpt-5.4-pro",
        CodexPricing {
            input_per_million: 30.0,
            output_per_million: 180.0,
        },
    );
    map.insert(
        "gpt-5.3-codex",
        CodexPricing {
            input_per_million: 1.75,
            output_per_million: 14.0,
        },
    );
    map.insert(
        "gpt-5-codex",
        CodexPricing {
            input_per_million: 1.25,
            output_per_million: 10.0,
        },
    );
    map
});

static CODEX_PRICING_HISTORICAL: LazyLock<HashMap<&'static str, CodexPricing>> =
    LazyLock::new(|| {
        let mut map = HashMap::new();
        map.insert(
            "gpt-5.2-codex",
            CodexPricing {
                input_per_million: 1.75,
                output_per_million: 14.0,
            },
        );
        map.insert(
            "gpt-5.1-codex",
            CodexPricing {
                input_per_million: 1.25,
                output_per_million: 10.0,
            },
        );
        map.insert(
            "gpt-5.1-codex-max",
            CodexPricing {
                input_per_million: 1.25,
                output_per_million: 10.0,
            },
        );
        map.insert(
            "gpt-5.1-codex-mini",
            CodexPricing {
                input_per_million: 0.25,
                output_per_million: 2.0,
            },
        );
        map.insert(
            "gpt-5",
            CodexPricing {
                input_per_million: 1.25,
                output_per_million: 10.0,
            },
        );
        map.insert(
            "gpt-5.1",
            CodexPricing {
                input_per_million: 1.25,
                output_per_million: 10.0,
            },
        );
        map
    });

static CODEX_PRICING_BY_ID: LazyLock<HashMap<&'static str, CodexPricing>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    map.extend(CODEX_PRICING_CURRENT.iter());
    map.extend(CODEX_PRICING_HISTORICAL.iter());
    map
});

#[derive(Debug, Clone)]
struct FallbackEntry {
    pattern: regex::Regex,
    pricing: CodexPricing,
}

static FAMILY_FALLBACK: LazyLock<Vec<FallbackEntry>> = LazyLock::new(|| {
    vec![
        FallbackEntry {
            pattern: regex::Regex::new(r"-nano$").unwrap(),
            pricing: CodexPricing {
                input_per_million: 0.2,
                output_per_million: 1.25,
            },
        },
        FallbackEntry {
            pattern: regex::Regex::new(r"-mini$").unwrap(),
            pricing: CodexPricing {
                input_per_million: 0.25,
                output_per_million: 2.0,
            },
        },
        FallbackEntry {
            pattern: regex::Regex::new(r"-codex(-max)?$").unwrap(),
            pricing: CodexPricing {
                input_per_million: 1.25,
                output_per_million: 10.0,
            },
        },
        FallbackEntry {
            pattern: regex::Regex::new(r"^gpt-6").unwrap(),
            pricing: CodexPricing {
                input_per_million: 10.0,
                output_per_million: 50.0,
            },
        },
        FallbackEntry {
            pattern: regex::Regex::new(r"^gpt-5").unwrap(),
            pricing: CodexPricing {
                input_per_million: 1.25,
                output_per_million: 10.0,
            },
        },
    ]
});

pub fn find_codex_pricing(
    model: &str,
    _usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> Option<CodexPricing> {
    let id = strip_model_effort_suffix(&strip_model_version_suffixes(model)).to_lowercase();

    if let Some(pricing) = CODEX_PRICING_BY_ID.get(id.as_str()) {
        return Some(*pricing);
    }

    // Try family fallback
    for entry in FAMILY_FALLBACK.iter() {
        if entry.pattern.is_match(&id) {
            if let Some(fb) = fallbacks {
                fb.record(&id);
            }
            return Some(entry.pricing);
        }
    }

    None
}

pub fn estimate_codex_cost_usd(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: u64,
    usage_date: Option<&str>,
    fallbacks: Option<&FallbackCollector>,
) -> Option<f64> {
    let pricing = find_codex_pricing(model, usage_date, fallbacks)?;

    let fresh = input_tokens.saturating_sub(cached_input_tokens);
    let cached = cached_input_tokens.min(input_tokens);

    Some(
        (fresh as f64 * pricing.input_per_million
            + cached as f64 * pricing.input_per_million * CACHE_READ_RATE_MULTIPLIER
            + output_tokens as f64 * pricing.output_per_million)
            / 1_000_000.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_codex_pricing() {
        let pricing = find_codex_pricing("gpt-5-codex", None, None).unwrap();
        assert_eq!(pricing.input_per_million, 1.25);
        assert_eq!(pricing.output_per_million, 10.0);
    }

    #[test]
    fn test_estimate_codex_cost() {
        let cost =
            estimate_codex_cost_usd("gpt-5-codex", 1_000_000, 1_000_000, 0, None, None).unwrap();
        assert_eq!(cost, 11.25); // 1.25 + 10
    }

    #[test]
    fn test_fallback_nano() {
        let pricing = find_codex_pricing("gpt-5.7-nano", None, None).unwrap();
        assert_eq!(pricing.input_per_million, 0.2);
    }
}
