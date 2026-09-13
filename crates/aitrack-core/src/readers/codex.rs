//! Codex reader.

use crate::data::day_map::{add_model_usage, merge_day_maps, try_local_date_string};
use crate::data::types::DayMap;
use crate::pricing::codex::estimate_codex_cost_usd;
use crate::pricing::fallback::FallbackCollector;
use crate::readers::cache::CachedParse;
use crate::readers::jsonl::stream_jsonl_objects;
use crate::readers::paths::get_codex_paths;
use crate::readers::pipeline::parse_provider_sources;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone)]
struct TokenUsage {
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
}

#[derive(Debug, Clone)]
struct SessionResult {
    date_str: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: u64,
}

fn token_usage_values(usage: &serde_json::Map<String, Value>) -> TokenUsage {
    TokenUsage {
        input_tokens: usage
            .get("input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        output_tokens: usage
            .get("output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        cached_input_tokens: usage
            .get("cached_input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
    }
}

fn add_session_usage(
    results: &mut HashMap<String, SessionResult>,
    date_str: String,
    model: String,
    usage: TokenUsage,
) {
    if usage.input_tokens == 0 && usage.output_tokens == 0 {
        return;
    }

    let key = format!("{}\0{}", date_str, model);
    let result = results.entry(key).or_insert(SessionResult {
        date_str: date_str.clone(),
        model: model.clone(),
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
    });

    result.input_tokens += usage.input_tokens as u64;
    result.output_tokens += usage.output_tokens as u64;
    result.cached_input_tokens += usage.cached_input_tokens as u64;
}

/// Parse one Codex session file.
fn parse_session_file(file_path: &Path) -> anyhow::Result<Vec<SessionResult>> {
    let mut current_date: Option<String> = None;
    let mut model = "unknown".to_string();
    let mut previous_total = TokenUsage {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
    };
    let mut results = HashMap::new();

    for obj in stream_jsonl_objects(file_path)? {
        // Update current date if timestamp is present
        if let Some(timestamp) = obj.get("timestamp").and_then(|v| v.as_str()) {
            if let Some(ds) = try_local_date_string(timestamp) {
                current_date = Some(ds);
            }
        }

        // Update model if turn_context with model
        if obj.get("type").and_then(|v| v.as_str()) == Some("turn_context") {
            if let Some(payload) = obj.get("payload").and_then(|v| v.as_object()) {
                if let Some(m) = payload.get("model").and_then(|v| v.as_str()) {
                    model = m.to_string();
                }
            }
        }

        // Process token_count events
        if obj.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
            continue;
        }

        let payload = match obj.get("payload").and_then(|v| v.as_object()) {
            Some(p) => p,
            None => continue,
        };

        if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
            continue;
        }

        let info = match payload.get("info").and_then(|v| v.as_object()) {
            Some(i) => i,
            None => continue,
        };

        let usage_opt = if let Some(total) =
            info.get("total_token_usage").and_then(|v| v.as_object())
        {
            let current = token_usage_values(total);

            // Check for rollback
            let is_rolled_back = current.input_tokens < previous_total.input_tokens
                || current.output_tokens < previous_total.output_tokens
                || current.cached_input_tokens < previous_total.cached_input_tokens;

            let usage = if is_rolled_back {
                if let Some(last) = info.get("last_token_usage").and_then(|v| v.as_object()) {
                    token_usage_values(last)
                } else {
                    current.clone()
                }
            } else {
                TokenUsage {
                    input_tokens: (current.input_tokens - previous_total.input_tokens).max(0),
                    output_tokens: (current.output_tokens - previous_total.output_tokens).max(0),
                    cached_input_tokens: (current.cached_input_tokens
                        - previous_total.cached_input_tokens)
                        .max(0),
                }
            };

            previous_total = current;
            Some(usage)
        } else {
            info.get("last_token_usage")
                .and_then(|v| v.as_object())
                .map(token_usage_values)
        };

        if let (Some(date), Some(usage)) = (&current_date, usage_opt) {
            add_session_usage(&mut results, date.clone(), model.clone(), usage);
        }
    }

    Ok(results.into_values().collect())
}

pub fn parse_codex_file(file_path: &Path) -> anyhow::Result<CachedParse> {
    let mut days = DayMap::new();

    for result in parse_session_file(file_path)? {
        let day = days.entry(result.date_str.clone()).or_default();

        let cost = estimate_codex_cost_usd(
            &result.model,
            result.input_tokens,
            result.output_tokens,
            result.cached_input_tokens,
            Some(&result.date_str),
            None,
        );

        add_model_usage(
            day,
            &result.model,
            &crate::data::types::TokenCounts {
                input_tokens: result.input_tokens,
                output_tokens: result.output_tokens,
                cached_input_tokens: Some(result.cached_input_tokens),
                raw_input_tokens: None,
                cache_creation_input_tokens: None,
                cost_usd: cost,
            },
        );
    }

    Ok(CachedParse {
        days,
        keys: Vec::new(), // Codex has no cross-file deduplication
    })
}

pub fn read_codex_data(_fallbacks: Option<&mut FallbackCollector>) -> anyhow::Result<DayMap> {
    let roots = get_codex_paths();
    let result = parse_provider_sources("codex", roots, parse_codex_file)?;

    let mut all_days = DayMap::new();
    for entry in result.parsed {
        merge_day_maps(&mut all_days, &entry.days);
    }

    Ok(all_days)
}
