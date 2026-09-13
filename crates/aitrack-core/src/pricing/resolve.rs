//! Model cost resolution across providers.

use super::claude::{ClaudeCountsBreakdown, estimate_claude_cost_from_stored_counts};
use super::codex::estimate_codex_cost_usd;
use crate::data::types::TokenCounts;

/// Resolve cost for a model given its token counts and provider.
pub fn resolve_model_cost(
    provider_key: &str,
    model: &str,
    counts: &TokenCounts,
    usage_date: Option<&str>,
) -> Option<f64> {
    // If cost is already stored, use it
    if let Some(cost) = counts.cost_usd {
        return Some(cost);
    }

    // Try to estimate based on provider
    match provider_key {
        "claude_code" | "claude" => {
            let breakdown = ClaudeCountsBreakdown {
                input_tokens: counts.input_tokens,
                output_tokens: counts.output_tokens,
                raw_input_tokens: counts.raw_input_tokens,
                cached_input_tokens: counts.cached_input_tokens,
                cache_creation_input_tokens: counts.cache_creation_input_tokens,
            };
            estimate_claude_cost_from_stored_counts(model, &breakdown, usage_date, None)
        }
        "codex" => estimate_codex_cost_usd(
            model,
            counts.input_tokens,
            counts.output_tokens,
            counts.cached_input_tokens.unwrap_or(0),
            usage_date,
            None,
        ),
        "cursor" => None, // Cursor has no cost
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_stored_cost() {
        let counts = TokenCounts {
            input_tokens: 1000,
            output_tokens: 500,
            cost_usd: Some(1.5),
            ..Default::default()
        };

        let cost = resolve_model_cost("claude_code", "claude-opus-4-6", &counts, None);
        assert_eq!(cost, Some(1.5));
    }
}
